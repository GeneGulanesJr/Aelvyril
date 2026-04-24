//! Background thread pool for ONNX inference.
//!
//! ONNX Runtime calls are CPU-bound and can block the tokio runtime.
//! This module provides a dedicated thread pool so inference doesn't
//! stall the gateway's async event loop.

use std::sync::Arc;
use tokio::sync::oneshot;

/// Maximum concurrent ONNX inference tasks.
/// Keep this small — the model is CPU-heavy and each task uses the
/// full vocab size tensor. 2 concurrent tasks saturate most CPUs.
const MAX_CONCURRENT_INFERENCE: usize = 2;

/// A background executor for CPU-bound ONNX inference work.
///
/// Spawns a fixed pool of OS threads that process inference tasks
/// via a shared MPSC channel. This keeps the tokio async runtime
/// free to handle HTTP requests while inference runs.
pub struct InferenceExecutor {
    sender: tokio::sync::mpsc::Sender<InferenceTask>,
    _handles: Vec<std::thread::JoinHandle<()>>,
}

struct InferenceTask {
    work: Box<dyn FnOnce() + Send + 'static>,
    done: oneshot::Sender<()>,
}

impl InferenceExecutor {
    /// Create a new executor with a pool of worker threads.
    pub fn new() -> Self {
        let (sender, receiver) =
            tokio::sync::mpsc::channel::<InferenceTask>(MAX_CONCURRENT_INFERENCE);

        // Wrap the receiver in Arc<Mutex> so multiple worker threads can share it.
        let shared_receiver = Arc::new(parking_lot::Mutex::new(receiver));
        let mut handles = Vec::new();

        for i in 0..MAX_CONCURRENT_INFERENCE {
            let rx = Arc::clone(&shared_receiver);
            let handle = std::thread::spawn(move || {
                tracing::info!("ONNX inference worker {} started", i);
                loop {
                    // Try to receive a task. blocking_recv requires &mut Receiver,
                    // so we lock, take, recv, and put back.
                    let task = {
                        let mut guard = rx.lock();
                        guard.try_recv()
                    };

                    match task {
                        Ok(task) => {
                            tracing::trace!("Inference worker {} picked up task", i);
                            (task.work)();
                            let _ = task.done.send(());
                        }
                        Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                            // No task available — sleep briefly to avoid busy-waiting
                            std::thread::sleep(std::time::Duration::from_millis(10));
                            continue;
                        }
                        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                            tracing::info!("Inference worker {} shutting down", i);
                            break;
                        }
                    }
                }
            });
            handles.push(handle);
        }

        Self {
            sender,
            _handles: handles,
        }
    }

    /// Spawn a CPU-bound task on the inference thread pool.
    /// Returns a future that resolves when the task completes.
    pub async fn spawn<F, T>(&self, work: F) -> T
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let (done_tx, done_rx) = oneshot::channel();

        // Use Option inside Mutex to transfer the result from the worker thread
        // to the async context. The worker writes exactly once, we read exactly once.
        let result_holder = Arc::new(parking_lot::Mutex::new(None::<T>));
        let result_for_worker = Arc::clone(&result_holder);

        let wrapped: Box<dyn FnOnce() + Send + 'static> = Box::new(move || {
            let val = work();
            *result_for_worker.lock() = Some(val);
        });

        self.sender
            .send(InferenceTask {
                work: wrapped,
                done: done_tx,
            })
            .await
            .expect("Inference executor shut down");

        // Wait for the worker to signal completion
        let _ = done_rx.await;

        // Extract the result
        let mut guard = result_holder.lock();
        guard
            .take()
            .expect("Inference worker did not set result")
    }
}

impl Default for InferenceExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_executor_runs_work() {
        let executor = InferenceExecutor::new();
        let result = executor.spawn(|| 2 + 2).await;
        assert_eq!(result, 4);
    }

    #[tokio::test]
    async fn test_executor_concurrent_work() {
        let executor = InferenceExecutor::new();
        let (r1, r2, r3) = tokio::join!(
            executor.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(50));
                1
            }),
            executor.spawn(|| 10 * 10),
            executor.spawn(|| "hello".to_string()),
        );
        assert_eq!(r1, 1);
        assert_eq!(r2, 100);
        assert_eq!(r3, "hello");
    }

    #[tokio::test]
    async fn test_executor_large_result() {
        let executor = InferenceExecutor::new();
        let result = executor.spawn(|| vec![0u8; 1024 * 1024]).await;
        assert_eq!(result.len(), 1024 * 1024);
    }
}

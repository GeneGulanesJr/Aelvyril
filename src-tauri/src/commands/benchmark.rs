use tauri::State;
use crate::benchmark::{BenchmarkConfig, BenchmarkResult};
use crate::AppState;

#[tauri::command]
pub async fn benchmark_pii_run(
    config: BenchmarkConfig,
    state: State<'_, AppState>,
) -> Result<BenchmarkResult, String> {
    crate::benchmark::benchmark_pii_run(config, state).await
}

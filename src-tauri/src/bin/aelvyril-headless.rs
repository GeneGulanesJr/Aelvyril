use aelvyril_lib::{
    gateway::{self, GatewayState},
    state::AppState,
};
use clap::Parser;
use reqwest;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::runtime::Runtime;

#[derive(Parser, Debug)]
#[command(
    name = "aelvyril-headless",
    about = "Run Aelvyril gateway in headless (no-UI) mode for CI/CD and benchmarking",
    version
)]
struct Args {
    #[arg(long, default_value = "127.0.0.1")]
    address: String,

    #[arg(long, default_value_t = 4242)]
    port: u16,

    #[arg(long)]
    all_interfaces: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = Args::parse();

    let host = if args.all_interfaces { "0.0.0.0" } else { &args.address };
    let host_owned = host.to_string();
    let socket_addr: SocketAddr = format!("{}:{}", host, args.port).parse()?;

    println!("[INFO] Initializing AppState...");
    // AppState::new() uses reqwest::blocking internally (LiteLLM pricing fetch).
    // Must be called BEFORE entering the tokio async runtime to avoid panic:
    // "Cannot drop a runtime in a context where blocking is not allowed."
    let app_state = Arc::new(RwLock::new(AppState::new()));
    println!("[INFO] AppState initialized");

    let rt = Runtime::new()?;

    // Initialize LLM PII backend if a GGUF model is available.
    // Wrapped in a single block_on call so all async ops run in one
    // runtime context (avoids "no reactor running" panics).
    #[cfg(feature = "llama")]
    {
        use aelvyril_lib::pii::PiiEngine;
        use std::path::PathBuf;
        let model_path = PathBuf::from("resources/models/pii-q4_k_m.gguf");
        if model_path.exists() {
            println!("[INFO] Initializing LLM PII backend from {:?} (30s timeout)...", model_path);
            rt.block_on(async {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    PiiEngine::init_llama(&model_path.to_string_lossy()),
                ).await {
                    Ok(Ok(detector)) => {
                        let mut state = app_state.write().await;
                        state.pii_engine.write().await.set_llama_detector(detector);
                        println!("[INFO] LLM PII backend loaded successfully");
                    }
                    Ok(Err(e)) => eprintln!("[WARN] Failed to init LLM backend: {}", e),
                    Err(_) => eprintln!("[WARN] LLM backend init timed out (30s) — continuing without it"),
                }
            });
        } else {
            eprintln!("[INFO] No LLM model found at {} — skipping LLM backend", model_path.display());
        }
    }

    // Build GatewayState with current lib API (all cloning is cheap Arc)
    let pii_engine = {
        let state_guard = rt.block_on(app_state.read());
        state_guard.pii_engine.clone()
    };
    let http_client = reqwest::Client::new();
    let gw_state = GatewayState {
        app_state: app_state.clone(),
        http_client,
        pii_engine,
    };

    // Configure headless/benchmark mode
    rt.block_on(async {
        let mut state = app_state.write().await;
        state.gateway_key = Some("aelvyril-benchmark-key".to_string());
        // Inject a dummy provider so model="none" resolves
        state.providers.push(aelvyril_lib::config::ProviderConfig {
            id: "benchmark-dummy".into(),
            name: "BenchmarkDummy".into(),
            base_url: "http://localhost:9999".into(),
            models: vec!["none".into()],
        });
        // Store a gateway key that matches the evaluator's --gateway-key
        let _ = aelvyril_lib::keychain::store_provider_key("BenchmarkDummy", "aelvyril-benchmark-key");
        // Disable rate limiting for benchmark runs
        state.rate_limiter = aelvyril_lib::security::rate_limit::RateLimiter::new(
            aelvyril_lib::security::rate_limit::RateLimitConfig {
                max_requests_per_minute: 10_000,
                max_requests_per_hour: 1_000_000,
                max_concurrent_requests: 1_000,
            },
        );
        // Enable Presidio directly — analyzer will lazy-init on first call
        state.pii_engine.write().await.set_presidio_enabled(true);
    });

    // Start HTTP gateway immediately
    println!("[INFO] Starting gateway on http://{}", socket_addr);
    rt.block_on(gateway::run_gateway(gw_state, host_owned, args.port))?;

    Ok(())
}

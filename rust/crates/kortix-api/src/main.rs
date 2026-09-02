use anyhow::{Context, Result};
use kortix_api::{app, config::Config, AppState};
use tokio::net::TcpListener;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    init_tracing();
    if let Err(error) = run().await {
        error!(error = ?error, "service terminated");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let config = Config::from_process_env().context("invalid service configuration")?;
    let state = AppState::new(&config);
    let router = app(state.clone());
    let listener = TcpListener::bind(&config.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", config.bind_addr))?;

    state.mark_ready();
    info!(
        address = %config.bind_addr,
        environment = %config.environment,
        version = %config.version,
        commit = %config.commit,
        "service started"
    );

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal(state))
        .await
        .context("HTTP server failed")?;
    info!("service stopped");
    Ok(())
}

async fn shutdown_signal(state: AppState) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    error!(error = ?error, "SIGINT handler failed");
                }
            }
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    if let Err(error) = tokio::signal::ctrl_c().await {
        error!(error = ?error, "shutdown signal handler failed");
    }

    state.begin_shutdown();
    info!("shutdown started");
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .init();
}

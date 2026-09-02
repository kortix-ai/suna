use anyhow::{Context, Result};
use kortix_api::{app, config::Config, spawn_event_loop_lag_sampler, AppState};
use tokio::{
    net::TcpListener,
    sync::watch,
    time::{sleep, timeout},
};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[cfg(unix)]
struct ShutdownSignals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl ShutdownSignals {
    fn install() -> std::io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
        })
    }

    async fn recv(mut self) {
        tokio::select! {
            _ = self.interrupt.recv() => {}
            _ = self.terminate.recv() => {}
        }
    }
}

#[cfg(windows)]
struct ShutdownSignals {
    ctrl_c: tokio::signal::windows::CtrlC,
}

#[cfg(windows)]
impl ShutdownSignals {
    fn install() -> std::io::Result<Self> {
        Ok(Self {
            ctrl_c: tokio::signal::windows::ctrl_c()?,
        })
    }

    async fn recv(mut self) {
        let _ = self.ctrl_c.recv().await;
    }
}

fn main() {
    let config = match Config::from_process_env().context("invalid service configuration") {
        Ok(config) => config,
        Err(error) => {
            eprintln!("service terminated: {error:?}");
            std::process::exit(1);
        }
    };
    init_tracing();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build Tokio runtime");
    if let Err(error) = runtime.block_on(run(config)) {
        error!(error = ?error, "service terminated");
        std::process::exit(1);
    }
}

async fn run(config: Config) -> Result<()> {
    let state = AppState::new(&config);
    let router = app(state.clone());
    let listener = TcpListener::bind(&config.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", config.bind_addr))?;
    let sampler = spawn_event_loop_lag_sampler(state.event_loop_lag());
    let shutdown_signals =
        ShutdownSignals::install().context("failed to install shutdown signal handlers")?;
    let (graceful_tx, mut graceful_started) = watch::channel(false);
    let mut graceful_rx = graceful_tx.subscribe();

    state.mark_ready();
    info!(
        address = %config.bind_addr,
        environment = %config.environment,
        version = %config.version,
        commit = %config.commit,
        "service started"
    );

    tokio::spawn(shutdown_controller(
        shutdown_signals,
        state,
        config.advertised_drain,
        graceful_tx,
    ));

    let server = async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = graceful_rx.wait_for(|started| *started).await;
            })
            .await
    };
    tokio::pin!(server);

    tokio::select! {
        result = &mut server => result.context("HTTP server failed")?,
        changed = graceful_started.changed() => {
            if changed.is_ok() {
                match timeout(config.max_graceful_drain, &mut server).await {
                    Ok(result) => result.context("HTTP server failed")?,
                    Err(_) => warn!(
                        max_graceful_drain_ms = config.max_graceful_drain.as_millis(),
                        "maximum graceful drain elapsed; closing remaining connections"
                    ),
                }
            }
        }
    }
    sampler.abort();
    info!("service stopped");
    Ok(())
}

async fn shutdown_controller(
    signals: ShutdownSignals,
    state: AppState,
    advertised_drain: std::time::Duration,
    graceful_tx: watch::Sender<bool>,
) {
    signals.recv().await;

    state.begin_shutdown();
    info!(
        advertised_drain_ms = advertised_drain.as_millis(),
        "readiness set to draining"
    );
    sleep(advertised_drain).await;
    let _ = graceful_tx.send(true);
    info!("graceful connection drain started");
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

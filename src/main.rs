use anyhow::{Context, Result};
use nostube_search::{indexer, net::Meili, server};
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    let meili = Meili::from_env()?;
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3001".into())
        .parse()
        .context("Invalid PORT")?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).await?;
    let app = server::router(meili.clone());
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let mut indexer_task = tokio::spawn(indexer::run_until(meili, stopped));
    eprintln!("Search API running on http://0.0.0.0:{port}");
    let http = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        let _ = stop.send(true);
    });
    tokio::select! {
        result = http => { result?; indexer_task.await.context("Indexer task panicked")??; }
        result = &mut indexer_task => { result.context("Indexer task panicked")??; }
    }
    Ok(())
}
#[allow(
    clippy::expect_used,
    reason = "startup only: without signals the container cannot stop cleanly"
)]
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("installing the SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

//! Clipboard backends behind a single trait so Wayland/X11 never leak into sync logic.
use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::mpsc;

/// Text-only for v1 (plan §1). Binary/HTML deferred.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardText(pub String);

#[async_trait]
pub trait ClipboardProvider: Send + Sync {
    async fn read(&self) -> Result<Option<ClipboardText>>;
    async fn write(&self, text: &str) -> Result<()>;
    /// Spawn a background watch loop; sends new text values (origin-tagged by caller).
    async fn watch(&self, tx: mpsc::Sender<ClipboardText>) -> Result<()>;
}

/// Wayland provider (Ubuntu 24.04 / Fedora GNOME Wayland).
/// Uses `arboard` which talks to the Wayland data-control protocol via the
/// compositor; on GNOME this requires the app to hold clipboard ownership or
/// use the portal helper. Poll-based watch keeps CPU low and avoids portal
/// event-plumbing in v1.
pub struct WaylandProvider {
    pub poll_ms: u64,
}

#[async_trait]
impl ClipboardProvider for WaylandProvider {
    async fn read(&self) -> Result<Option<ClipboardText>> {
        let text = tokio::task::spawn_blocking(|| {
            let mut cb = arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("{e}"))?;
            match cb.get_text() {
                Ok(t) => Ok::<_, anyhow::Error>(Some(ClipboardText(t))),
                Err(arboard::Error::ContentNotAvailable) => Ok(None),
                Err(e) => Err(anyhow::anyhow!("{e}")),
            }
        })
        .await??;
        Ok(text)
    }

    async fn write(&self, text: &str) -> Result<()> {
        let text = text.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut cb = arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("{e}"))?;
            cb.set_text(text).map_err(|e| anyhow::anyhow!("{e}"))
        })
        .await??;
        Ok(())
    }

    async fn watch(&self, tx: mpsc::Sender<ClipboardText>) -> Result<()> {
        let mut last: Option<String> = None;
        loop {
            if let Some(ClipboardText(t)) = self.read().await.unwrap_or(None) {
                if last.as_ref() != Some(&t) {
                    last = Some(t.clone());
                    if tx.send(ClipboardText(t)).await.is_err() {
                        break;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(self.poll_ms)).await;
        }
        Ok(())
    }
}

/// X11 fallback provider (X11 sessions / XWayland where practical).
/// Same polling strategy; separate type so callers can log which backend is active.
pub struct X11Provider {
    pub poll_ms: u64,
}

#[async_trait]
impl ClipboardProvider for X11Provider {
    async fn read(&self) -> Result<Option<ClipboardText>> {
        WaylandProvider { poll_ms: self.poll_ms }.read().await
    }
    async fn write(&self, text: &str) -> Result<()> {
        WaylandProvider { poll_ms: self.poll_ms }.write(text).await
    }
    async fn watch(&self, tx: mpsc::Sender<ClipboardText>) -> Result<()> {
        WaylandProvider { poll_ms: self.poll_ms }.watch(tx).await
    }
}

/// Auto-detect: prefer Wayland when WAYLAND_DISPLAY is set, else X11.
pub fn autodetect(poll_ms: u64) -> Box<dyn ClipboardProvider> {
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        Box::new(WaylandProvider { poll_ms })
    } else {
        Box::new(X11Provider { poll_ms })
    }
}

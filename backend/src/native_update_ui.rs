use std::sync::Arc;

#[derive(Clone)]
pub struct NativeUpdateUi {
    platform: Result<Arc<platform::PlatformUi>, Arc<str>>,
}

impl NativeUpdateUi {
    pub fn start() -> Self {
        match platform::PlatformUi::start() {
            Ok(platform) => Self {
                platform: Ok(Arc::new(platform)),
            },
            Err(error) => {
                eprintln!("{error}");
                Self {
                    platform: Err(Arc::from(error)),
                }
            }
        }
    }

    pub fn shutdown(&self) {
        if let Ok(platform) = &self.platform {
            platform.shutdown();
        }
    }
}

pub fn run_macos_application<F>(run: F) -> anyhow::Result<()>
where
    F: FnOnce() -> anyhow::Result<()> + Send + 'static,
{
    platform::run_application(run)
}

mod platform {
    use std::cell::RefCell;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::sync::{Arc, mpsc};
    use std::thread;

    use dispatch2::MainThreadBound;
    use objc2::MainThreadMarker;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    use super::NativeUpdateUi;

    struct MacUiState {
        app: Retained<NSApplication>,
    }

    pub struct PlatformUi {
        state: Arc<MainThreadBound<RefCell<MacUiState>>>,
    }

    impl PlatformUi {
        pub fn start() -> Result<Self, String> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "macOS 应用循环必须在主线程初始化".to_string())?;
            let app = NSApplication::sharedApplication(mtm);
            Ok(Self {
                state: Arc::new(MainThreadBound::new(RefCell::new(MacUiState { app }), mtm)),
            })
        }

        pub fn shutdown(&self) {
            self.state.get_on_main(|state| {
                state.borrow().app.stop(None);
            });
        }
    }

    pub fn run_application<F>(run: F) -> anyhow::Result<()>
    where
        F: FnOnce() -> anyhow::Result<()> + Send + 'static,
    {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| anyhow::anyhow!("macOS 应用循环必须在主线程运行"))?;
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        app.finishLaunching();
        let ui = NativeUpdateUi::start();
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("codey-runtime".to_string())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(run))
                    .unwrap_or_else(|_| Err(anyhow::anyhow!("Codey 运行线程异常退出")));
                ui.shutdown();
                let _ = result_tx.send(result);
            })?;

        app.run();
        let result = result_rx
            .recv()
            .map_err(|_| anyhow::anyhow!("Codey 运行线程未返回结果"))?;
        worker
            .join()
            .map_err(|_| anyhow::anyhow!("Codey 运行线程回收失败"))?;
        result
    }
}

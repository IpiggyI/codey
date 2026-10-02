use super::*;

#[derive(Default)]
pub(crate) struct ModelHotReloadOutcome {
    pub(crate) reloaded: bool,
    pub(crate) deferred: bool,
    pub(crate) error: Option<String>,
}

impl ModelHotReloadOutcome {
    pub(crate) fn add_to_response(self, mut response: Value) -> Value {
        if let Some(object) = response.as_object_mut() {
            object.insert("modelHotReloaded".into(), Value::Bool(self.reloaded));
            if self.deferred {
                object.insert("modelHotReloadDeferred".into(), Value::Bool(true));
            }
            if let Some(error) = self.error {
                object.insert("modelHotReloadError".into(), Value::String(error));
            }
        }
        response
    }
}

pub(crate) async fn runtime_renderer_model_catalog(state: &Arc<AppState>) -> Result<Value, String> {
    let _delivery = state.model_delivery_lock.lock().await;
    if let Some(runtime) = state.runtime.lock().await.clone() {
        if let Some(catalog) = runtime.delivered_model_catalog().await {
            return Ok(catalog);
        }
        return current_renderer_model_catalog_async(runtime.applied_config.clone()).await;
    }
    current_renderer_model_catalog_async(state.config.read().await.clone()).await
}

async fn refresh_current_renderer(
    runtime: &crate::launcher::CodeyRuntime,
    catalog: &Value,
) -> Result<cdp::ModelWhitelistRefresh, String> {
    let mut url = runtime.renderer_websocket_url().await;
    for _ in 0..2 {
        let result = cdp::refresh_model_whitelist(&url, catalog).await;
        let current = runtime.renderer_websocket_url().await;
        if Arc::ptr_eq(&url, &current) {
            return result.map_err(|error| format!("{error:#}"));
        }
        url = current;
    }
    Err("模型列表更新期间页面连续重连，请重试同步".into())
}

pub(crate) async fn hot_reload_runtime_models(state: &Arc<AppState>) -> ModelHotReloadOutcome {
    let _operation = state.runtime_operation.lock().await;
    let _delivery = state.model_delivery_lock.lock().await;
    if state.is_shutting_down() {
        return ModelHotReloadOutcome::default();
    }
    let Some(runtime) = state.runtime.lock().await.clone() else {
        return ModelHotReloadOutcome::default();
    };
    let config = state.config.read().await.clone();
    if !runtime_supports_current_routes_for_hot_reload(&runtime.applied_config, &config) {
        return ModelHotReloadOutcome::default();
    }
    let previous = match runtime.delivered_model_catalog().await {
        Some(catalog) => Ok(catalog),
        None => current_renderer_model_catalog_async(runtime.applied_config.clone()).await,
    };
    let expected = match current_renderer_model_catalog_async(config.clone()).await {
        Ok(catalog) => catalog,
        Err(error) => {
            return ModelHotReloadOutcome {
                error: Some(error),
                ..Default::default()
            };
        }
    };
    match refresh_current_renderer(&runtime, &expected).await {
        Ok(refresh) => {
            runtime.mark_model_catalog_applied(&config, expected).await;
            ModelHotReloadOutcome {
                reloaded: true,
                deferred: refresh.deferred,
                error: None,
            }
        }
        Err(error) => {
            let rollback = match previous {
                Ok(catalog) => refresh_current_renderer(&runtime, &catalog)
                    .await
                    .map(|_| ()),
                Err(error) => Err(error),
            };
            let error = match rollback {
                Ok(()) => error,
                Err(rollback) => format!("{error}；恢复原模型列表失败：{rollback}"),
            };
            error_log::record_failure(
                "patch_verification_failed",
                "refresh_model_whitelist",
                error.clone(),
                json!({"modelCount": expected.get("models").and_then(Value::as_array).map(Vec::len)}),
            );
            ModelHotReloadOutcome {
                error: Some(error),
                ..Default::default()
            }
        }
    }
}

#[cfg(test)]
#[path = "delivery_tests.rs"]
mod tests;

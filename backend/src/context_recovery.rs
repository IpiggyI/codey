#[derive(Clone, Copy)]
pub(crate) enum Purpose {
    Launch,
    ModelSync,
}

fn description(purpose: Purpose, reason: &str) -> String {
    let action = match purpose {
        Purpose::Launch => "重新启动",
        Purpose::ModelSync => "继续保存本次改动",
    };
    format!(
        "{reason}\n\n可以恢复所有模型的默认上下文预算并{action}，其他设置不受影响。Codey 配置会进入现有备份链，用户配置与原始模型目录保持不变。若要保留预算，请检查目录中的模型标识或重新同步模型。"
    )
}

pub(crate) async fn confirm(purpose: Purpose, reason: &str) -> Result<bool, String> {
    let message = description(purpose, reason);
    #[cfg(any(windows, target_os = "macos"))]
    {
        tokio::task::spawn_blocking(move || {
            rfd::MessageDialog::new()
                .set_title("Codey 上下文设置暂时无法使用")
                .set_description(message)
                .set_level(rfd::MessageLevel::Warning)
                .set_buttons(rfd::MessageButtons::OkCancelCustom(
                    "恢复默认预算并重试".into(),
                    "保留预算".into(),
                ))
                .show()
                == rfd::MessageDialogResult::Custom("恢复默认预算并重试".into())
        })
        .await
        .map_err(|error| format!("预算恢复确认任务异常退出：{error}"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err(format!("当前平台没有原生预算确认入口：{message}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_names_reason_and_reset_scope() {
        for purpose in [Purpose::Launch, Purpose::ModelSync] {
            let message = description(purpose, "目录缺少模型 example");
            assert!(message.starts_with("目录缺少模型 example"));
            assert!(message.contains("所有模型"));
            assert!(message.contains("原始模型目录保持不变"));
        }
    }
}

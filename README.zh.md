# dsh-quick-restart

给插件开发用的 DeepSeek Harness 插件包：在会话标题栏直接刷新页面或重启桌面应用，
改完插件不用再手动退出、重新打开。

## 加了什么

会话标题栏右上角常驻两个图标：

- **刷新**（圆形箭头）：`window.location.reload()`，让 **Client** 插件改动立即生效，不关窗口。
- **重启**（电源符号）：关闭桌面应用并用原命令行重新打开，**Host** 插件改动随之生效。

两个图标都有悬停底色和说明文字。重启失败会在右下角提示原因，不会一直停在「重启中」。

## 要求与限制

- **仅支持 Windows 桌面版。** 重启辅助脚本是同目录的 `restart.ps1`，通过 WMI 服务启动，
  以便在旧应用实例退出后继续存活。
- 重启会中断正在运行的对话，窗口会关闭几秒。
- 刷新只让 Client 插件改动生效，未发送的输入会丢失；`app.asar` 里的内置
  `@deepseek-ai/*` 插件仍需完整重启。
- 日志：`%TEMP%\dsh-quick-restart\restart-<时间戳>-<pid>.log`，保留 7 天。

## 安装

```sh
dsh plugin --profile <profile> add @iridensity_gray/dsh-quick-restart
```

安装后重启一次桌面应用，Host 行和标题栏控件才会注册。无需配置。

## 卸载

```sh
dsh plugin --profile <profile> remove @iridensity_gray/dsh-quick-restart
```

之后重启 DSH。

## 许可证

MIT

# Quick reload and restart

A DeepSeek Harness bundle for plugin development, so a change no longer needs a
manual quit-and-relaunch.

## What it adds

Two persistent 28px round icons in the session header's top-right utilities,
left of the `…` menu:

- **Restart** (power glyph: an unclosed circle with a short vertical line) asks
  the Host to close the desktop application and open it again with the same
  command line, so **Host** plugin changes take effect.
- **Reload** (circular arrow) runs `window.location.reload()`, so **Client**
  plugin changes take effect without closing the window.

Both are plain slot registrations with hover fill and tooltips. A restart
interrupts a running conversation: the window closes and reopens by itself
after a few seconds. A failure shows its reason in a bottom-right notice
instead of staying on "restarting" forever.

## Behaviour and limits

- Windows desktop only. The restart route is a loopback-only HTTP endpoint and
  the helper is `restart.ps1` next to this package.
- The Host starts the helper through the WMI service on purpose: DSH ends the
  processes it spawns when a Host shutdown ends its command job, and this
  helper must outlive the old app instance.
- The helper first asks the shell to quit gracefully (session end + window
  close). If the application is still running after 7 s it terminates the
  process; the Host still shuts down gracefully when its IPC channel closes.
  It then waits for the Host to exit and starts the application again with the
  original arguments.
- The Client asks the Host for the outcome, so a helper that never starts is
  reported as a failure.
- Reload only picks up Client plugin changes and discards unsaved composer
  input; it cannot reload built-in `@deepseek-ai/*` packages that live inside
  `app.asar`.

## Logs

`%TEMP%\dsh-quick-restart\restart-<timestamp>-<pid>.log`, kept for 7 days.

## Install

```sh
dsh plugin --profile <profile> add @iridensity_gray/dsh-quick-restart
```

No configuration is required. Restart the desktop app once after installing so
the Host row and the header controls are registered.

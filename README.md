# dsh-quick-restart

A DeepSeek Harness bundle for plugin development: reload the page or relaunch
the desktop app from the session header, so a change no longer needs a manual
quit-and-relaunch.

## What it adds

Two persistent icons in the session header's top-right utilities:

- **Reload** (circular arrow) — `window.location.reload()`, so **client**
  plugin changes apply without closing the window.
- **Restart** (power glyph) — closes the desktop app and reopens it with the
  same command line, so **host** plugin changes take effect.

Both have hover fill and tooltips. A failed restart is reported in a
bottom-right notice instead of an endless "restarting" state.

## Requirements and limits

- **Windows desktop only.** The restart helper is `restart.ps1` and is started
  through the WMI service so it outlives the old app instance.
- Restarting interrupts a running conversation; the window closes for a few
  seconds.
- Reload only picks up client plugin changes and discards unsaved composer
  input. Built-in `@deepseek-ai/*` plugins inside `app.asar` still need a full
  restart.
- Logs: `%TEMP%\dsh-quick-restart\restart-<timestamp>-<pid>.log`, kept 7 days.

## Install

```sh
dsh plugin --profile <profile> add @iridensity_gray/dsh-quick-restart
```

Then restart the desktop app once so the host row and header controls are
registered. No configuration is needed.

## Uninstall

```sh
dsh plugin --profile <profile> remove @iridensity_gray/dsh-quick-restart
```

Restart DSH afterwards.

## License

MIT

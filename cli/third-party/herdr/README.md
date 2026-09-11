# Herdr source provenance

Base: https://github.com/herdrdev/herdr/tree/ef4c23f5775bb8cfec05f05d0844226ff959a07a

Version: v0.7.5, commit `ef4c23f5775bb8cfec05f05d0844226ff959a07a`.
Adaptation date: 2026-09-10.
The license at this revision is AGPL-3.0-or-later; the complete license is in
`LICENSE`. Later Herdr releases may have different licenses.

`tabs.rs` and `sidebar.rs` are unmodified reference source. Their tab hit-area
layout, sidebar section geometry and mouse-driven navigation are adapted in
`../../src/chrome.rs`. `../../src/text.rs` is copied from `src/ui/text.rs`.
The default palette and prefix-key workflow also follow this revision.

The hati adaptation is a separate Rust TUI client. Herdr's daemon, process
ownership and agent detection are replaced with an IPC adapter to the existing
hati daemon. No Herdr server is started. Only terminal attachment clients live
in local PTYs. hati machine/Space/tab/thread identities remain authoritative.

Changes to the derived UI and the Rust client are supplied as source in `cli/`
under AGPL-3.0-or-later. The Node backend communicates over JSON lines and uses
hati's existing authenticated HTTP API.

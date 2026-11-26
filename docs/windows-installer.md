# Install Companion on Windows

The installer is a Windows Installer package (MSI) for Intel and AMD x64 PCs. It includes the Electron runtime, Companion, YAML, and the Windows x64 read probe. A standard user can install it offline. Windows 11 x64 is the acceptance target.

1. Obtain the reviewed `Companion-<version>-windows-x64.msi` and its SHA-256 checksum from the maintainer. Compare the complete checksum with the output of `Get-FileHash .\Companion-<version>-windows-x64.msi` in PowerShell.
2. Double-click the MSI. Then open **Companion** from Start. The default program directory is `%LOCALAPPDATA%\Companion Desktop`.
3. Select **Choose vault**, choose an ordinary local folder, and select **Use this folder**. Save a thought. Its Markdown file stays in the selected vault.

The review build is unsigned. Windows can show an unknown publisher warning, and organizational policy can block installation. A matching hash identifies the reviewed download. The Windows account can modify its installed files. Publisher authentication requires a trusted signature. Ask the maintainer or your administrator if Windows blocks the package. Native Arm64 and x86 packages are unavailable.

## Upgrade and remove

Close Companion before installing a higher version or removing it. Run the newer MSI in the same Windows account. Windows Installer replaces the previous version and keeps the Start shortcut and program path stable. Companion keeps its settings and local history under `%APPDATA%\companion`. Use a vault outside the program directory.

Daily intake is optional. If you already enabled it from a source checkout, use **Disable daily intake** in that checkout before enabling it in the installed app. Installed tasks launch the bundled executable. Upgrades retain the task and anchor. To remove the app, open **Settings → Apps → Installed apps → Companion → Uninstall**. Removal checks the saved task ID, Windows user, description, privilege level, action, arguments, and working directory before deleting the task. If the schedule record is damaged or unsupported, uninstall leaves the record and any unverifiable task in place. It preserves foreign tasks, settings, vaults and user-created files. If Windows reports an uninstall failure, close Companion, let any active intake finish, and retry. After reinstalling, use **Repair daily intake** to restore a previously enabled schedule.

**Open in Obsidian** requires the user's Obsidian protocol handler. Local capture works independently. The installer includes the probe and hash inputs for the optional Codex integration. Live sign-in and model readiness have separate verification gates.

## Build and verify

Use a clean checkout on Windows x64 with x64 Node.js 24, npm and Git. Prepare the portable WiX 3.14.1 build tools from the upstream release. Their archive SHA-256 is `6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31`. Extract the verified archive into `dist\wix`, or set `WIX_BIN` to the directory containing `candle.exe` and `light.exe`. WiX runs only on the build machine. WiX v3 community servicing ended in 2025. Review that toolchain choice before public distribution. [WiX 3.14.1 binaries](https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm) · [WiX servicing policy](https://docs.firegiant.com/wix/wix3/)

```powershell
npm ci
npm run prepare:electron
npm run check
npm run package:windows
```

The MSI and its `.sha256` file appear under `dist`. The package uses the locked runtime, tracked app files, the reviewed probe build script and the YAML runtime. The native adapter and probe remain ordinary files under `resources\app`. The application profile and vault are outside the installer inventory.

The native acceptance test opens visible Companion windows. It runs by default on GitHub-hosted Windows CI. For a coordinated local run, use an isolated desktop and a disposable, signed-in Windows account with permission to register its own scheduled tasks and no installed copy of Companion. Build the synthetic earlier version, then explicitly opt in.

```powershell
npm run package:windows -- 0.1.0
npm run test:installer -- --allow-visible-windows
```

The test prints its temporary evidence directory. It uses private program, menu, profile, source and vault paths. It checks actual MSI registration, a packaged desktop capture and restart, the Obsidian URI at the dispatch boundary, native probe hashes, native task execution, upgrade, ownership mismatch and uninstall. Hosted CI also opens the installed Start shortcut using the default Windows profile and checks uninstall with both valid and damaged schedule records. Its seven-day review artifact contains the tested MSI and checksum. Local Windows Installer logs and synthetic notes remain in the temporary directory for inspection.

For distribution, review the source PR and the exact local MSI hash first. After separate release approval, attach the approved MSI and checksum to the matching versioned GitHub Release. A rebuild or signature changes the bytes and requires a new checksum and verification.

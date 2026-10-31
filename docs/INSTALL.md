# Install Ardi

Requires Bun and the Pi coding agent. Check that `bun --version` and `pi --version` work in your terminal. The Chrome version runs on macOS, Linux and Windows; on Windows, Pi runs commands in PowerShell, so Git Bash isn't needed. The Ardia version runs on macOS and Linux and also needs its `ardia` CLI for browser control.

1. Extract the download for your browser and open a terminal (PowerShell on Windows) in that folder.
2. Run the matching command:

   ```sh
   bun install-host.ts ardia
   # For the Chrome download instead:
   bun install-host.ts chrome
   ```

3. Select the folder printed by the installer. In Ardia, go to **Settings → Extensions → Add extensions → Load unpacked extension**. In Chrome, open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
4. Open Ardi from the extensions menu.

To upgrade, run the installer from the new download and reload the extension. You can delete the extracted download after installation.

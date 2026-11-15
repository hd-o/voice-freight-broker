# Devcontainer

The devcontainer is preconfigured for SSH on `localhost:2222`.

Follow these instructions to connect from your host:

1. Export the public keys from your SSH agent:

   ```sh
   ssh-add -L > ~/.ssh/devcontainer_authorized_keys
   ```

   If `ssh-add -L` reports no identities, create a key like `ssh-add ~/.ssh/id_ed25519` and rerun.

2. Add this alias to `~/.ssh/config`:

   ```sshconfig
   Host devcontainer
       HostName localhost
       Port 2222
       User vscode
       StrictHostKeyChecking no
       UserKnownHostsFile /dev/null
   ```

3. Start the devcontainer, then connect:

   ```sh
   ssh devcontainer
   ```

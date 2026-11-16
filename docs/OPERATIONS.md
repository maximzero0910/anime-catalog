# Operations

These commands assume the Pi service names previously used in deployment. Confirm them on the target host before relying on them.

Set `HLS_ALLOWED_HOSTS` in the server environment before starting the API. Entries are comma-separated exact hosts; `*.zone.example` matches only subdomains of that specific provider-owned zone, not the apex. The checked-in example covers only observed resolver hosts and is not a complete provider inventory. Add a host only after confirming it is returned by an enabled provider. If the setting is empty or a host is not allowed, playback proxying fails closed (503 for missing configuration; 403 for a destination rejection).

```sh
sudo systemctl status anineko-web anineko-subtitles-worker anineko-telegram-sync
sudo journalctl -u anineko-web -u anineko-subtitles-worker --since '30 minutes ago' --no-pager
sudo systemctl restart anineko-web
sudo systemctl restart anineko-subtitles-worker
free -h; df -h; vmstat 1 5
```

Check the public liveness endpoint and a frontend page separately. Liveness should report only process availability; readiness should verify required local storage access without exposing paths or credentials. During an outage, check Tunnel status, service state, disk space, SQLite integrity, then upstream provider health. Do not restart workers repeatedly when their state indicates a provider cooldown.

On deployment, retain the previous release directory and the matching SQLite backup until smoke checks pass. Roll back the application bundle and restore data only when a migration is known to be backward-incompatible; never overwrite a newer live database with an older copy.

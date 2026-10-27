# Run First Twenty on your own server

First Twenty works in a browser with no server at all. This guide is for when you want your company's
data in your own Postgres database instead: every change syncs to the server, any computer you sign in
from sees the same data, and the database is backed up every night.

You will set up the **First Twenty server** on the same EC2 instance that already runs your Postgres.
Plan on about an hour the first time. Every command is here; copy them one at a time and read what each
one prints before moving on.

## What you get

```
  your browser ──HTTPS 443──> Caddy ──> First Twenty server ──> Postgres
                              (on the EC2 instance: 127.0.0.1:8787, then localhost:5432)
```

- **The app at your own address**, for example `https://hr.example.com`, with a real HTTPS certificate
  that renews itself (Caddy handles this).
- **The First Twenty server**, a small Node.js program that serves the app and its `/api`. It listens
  only on `127.0.0.1:8787`, so the internet reaches it only through Caddy.
- **Your data in Postgres**: one table per kind of record (people, candidates, jobs, and so on), each row
  holding the record as JSON. Postgres listens only on localhost; port 5432 is never opened.
- **Logins** that protect the data: your admin login, and teammates you invite with a link (see
  [Logins and the path to team roles](#logins-and-the-path-to-team-roles)).
- **Optionally, a public demo server**: anyone can create a demo company of their own and try First
  Twenty, many people at once (see [A public demo server](#a-public-demo-server)).
- **Optionally, careers pages**: every company's open jobs at an address of its own on a careers host,
  with an apply form that puts applicants straight into its pipeline (see [Careers pages](#careers-pages)).
- **Optionally, an HR assistant** in the app (Lark in the sample): answers questions from the company's
  records, explains the employment rules the app tracks and drafts text, using Anthropic's Claude API
  (see [Lark, the assistant](#lark-the-assistant)).
- **Nightly backups** of the database, kept for 14 days, optionally copied to S3.
- **Offline keeps working.** The browser keeps its own copy, queues changes while offline, and catches up
  when the connection returns. Once a browser has opened the app from your server's address, it opens it
  again even while the server cannot be reached (a new tab, a laptop restart): a small offline worker
  keeps the app page, never your data, and the app starts from the browser's own copy and says Offline.
  The worker always asks your server first: a browser whose offline storage is broken or full still
  opens the app normally, it just has no offline copy.

The kit lives in `server/deploy/`, plus `.env.example` in the project root:

| File | What it is |
|---|---|
| `setup-ec2.sh` | One-time setup: Node.js, Caddy, the service user, folders, settings file, services, backups. Safe to run again. |
| `postgres-setup.sql` | Creates the `first_twenty` database and its two login roles: `first_twenty_owner`, which owns the tables and runs migrations, and `first_twenty`, which the server uses to read and write rows. |
| `first-twenty.service` | The systemd service that runs the server, sandboxed: read-only code, a network limited to loopback and the Claude API, no privileged system calls. |
| `Caddyfile` | HTTPS and the reverse proxy to the server, plus a site per careers host when there are any. |
| `deploy.sh` | Updates the server to the latest code: pull, install, build, back up the database when migrations are pending, migrate, restart, health check. |
| `with-env.sh` | Runs a command (migrations, creating the admin) with the server's settings. |
| `backup.sh`, `first-twenty-backup.service`, `first-twenty-backup.timer` | The nightly backup. |
| `setup-auto-deploy.sh`, `auto-update.sh` | Optional automatic deploys: a staging copy that follows `main`, and the live server that follows the product owner's GitHub releases (see [Automatic deploys from GitHub](#automatic-deploys-from-github)). |
| `first-twenty-staging.service`, `first-twenty-staging-migrate.service`, `staging.caddy` | The staging server, its migrations and its Caddy site. |
| `first-twenty-autoupdate-staging.*`, `first-twenty-autoupdate-live.*` | The timers that run `auto-update.sh` every 5 minutes. |
| `.env.example` (project root) | Every setting the server reads, with a one-line explanation each. |

## Before you start

You need:

1. **An EC2 instance running Postgres 13 or newer**, on Amazon Linux 2023 or Ubuntu 22.04 / 24.04.
   Check the version on the instance with `sudo -u postgres psql -tAc 'SHOW server_version'`.
   An instance with 2 GB of memory or more builds comfortably. On a smaller one, such as a t3.micro
   (about 900 MB), setup adds a 2 GB swap file so the build fits (see step 2).
2. **An Elastic IP attached to the instance**, so its address never changes. In the EC2 console:
   Network & Security > Elastic IPs > Allocate, then Associate it with your instance.
3. **A domain name pointed at that Elastic IP**: an `A` record such as `hr.example.com` with the Elastic IP
   as its value, at whoever runs your DNS. Check it from your computer with `nslookup hr.example.com`;
   it must show the Elastic IP before Caddy can get a certificate. No domain yet? See
   [A free sslip.io name instead](#a-free-sslipio-name-instead).
4. **SSH access** to the instance with your key file. The login is `ec2-user` on Amazon Linux and
   `ubuntu` on Ubuntu. The examples below use `ec2-user` and `your-key.pem`; swap in yours.
5. **The First Twenty code**, either in a private Git repository (GitHub or similar) or on your computer.

Commands marked "on your computer" run in PowerShell or Git Bash in the project folder. Everything else
runs on the instance after you connect with (use the Elastic IP until DNS has caught up):

```bash
ssh -i your-key.pem ec2-user@hr.example.com
```

### A free sslip.io name instead

[sslip.io](https://sslip.io) answers any name that contains an IP address with that address, so
`hr-3-14-15-92.sslip.io` (the Elastic IP with dashes) works with no DNS setup, and Caddy can get a real
certificate for it. It is fine to start with, but a domain you own is better for good:

- **Strangers share the name.** sslip.io is not on the Public Suffix List, so every other
  `*.sslip.io` site, run by anyone, counts as the same site as yours. The server's defenses do not rely on
  that (its sign-in cookie is a `__Host-` cookie no other site can set or replace, and writes need a
  header no other page can send), but a page on another `*.sslip.io` name that you open can still stuff
  your browser with cookies for all of `sslip.io`, until every request to your site fails (Caddy or the
  server answers `431`). Clearing the site data for `sslip.io` in your browser fixes that, and also
  deletes the app's local copy and any changes not yet synced, so check that the header says Synced first
  if you can.
- **Certificates.** Let's Encrypt limits how many certificates one registered domain gets per week, and
  every sslip.io user shares those limits (sslip.io asks for raises, so far with success). If Caddy logs a
  rate-limit error, it retries on its own.
- **Only the Elastic IP.** Use the name of the Elastic IP, never of an address the instance had before:
  once released, an address goes to another AWS customer, who can then get a certificate for its name.

To move to your own domain later, re-run setup with it and set `PUBLIC_ORIGIN` to it. Each address keeps
its own cookies and browser storage, so at the new address sign in from **Settings > Server** and choose
**Use the server's copy**.

### Security group

In the EC2 console, open the instance's security group and make the inbound rules look like this:

| Port | Source | Why |
|---|---|---|
| 443 (HTTPS) | Anywhere (0.0.0.0/0) | The app. |
| 80 (HTTP) | Anywhere (0.0.0.0/0) | Lets Caddy prove it owns the domain to get the certificate, and redirects http:// to https://. |
| 22 (SSH) | My IP only | Your SSH access. Update it when your IP changes. |
| 5432 (Postgres) | **No rule** | Postgres must never be reachable from the internet. Delete this rule if one exists. |

Add `::/0` to the first two only if you give the instance an IPv6 address (EC2 instances have none by
default). With IPv6, one client can hold a whole range of addresses, so the sign-in limits count each
IPv6 network (/64) as one address. Leave UDP 443 closed: Caddy is set up without HTTP/3, which would
need it.

Leave the outbound rules at their default (all traffic), so the instance can reach package mirrors and
the certificate authority.

## Step 1: create the database roles

First Twenty uses two Postgres logins, both limited to the `first_twenty` database (see
[Two database roles](#two-database-roles)):

- `first_twenty`: what the running server uses. It can read, add, change and delete rows, and nothing
  else. It cannot create, change or drop tables.
- `first_twenty_owner`: owns the tables. Only `npm run server:migrate` (during setup and each update) and
  `npm run server:after-restore` use it.

Neither can create other databases, roles or extensions. The script is safe to run more than once and
does not touch any other database on the instance.

**Already ran `postgres-setup.sql` on this instance?** Then the database and both roles exist: skip this
step, do step 2, and follow [If your database and roles already exist](#if-your-database-and-roles-already-exist)
in step 3 to give the roles new passwords.

1. Make two long random passwords, one per role, and keep them somewhere safe for a moment (you paste
   them in step 3). Run this twice; the form avoids characters that would need escaping later:

   ```bash
   openssl rand -base64 33 | tr -d '/+=\n'; echo
   ```

2. Copy the script to the instance (on your computer):

   ```bash
   scp -i your-key.pem server/deploy/postgres-setup.sql ec2-user@hr.example.com:~
   ```

3. Run it as the Postgres superuser (on the instance). It asks for each role's password once, without
   showing it: first `first_twenty`, then `first_twenty_owner`.

   ```bash
   sudo -u postgres psql -v ON_ERROR_STOP=1 < ~/postgres-setup.sql
   ```

   If your Postgres runs in Docker, copy the file into the container and run it there with a terminal
   (`-it`), so the password prompts read from your keyboard rather than from the script:

   ```bash
   docker cp ~/postgres-setup.sql <container>:/tmp/postgres-setup.sql
   docker exec -it <container> psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/postgres-setup.sql
   ```

4. Check that Postgres listens on localhost only:

   ```bash
   sudo -u postgres psql -tAc 'SHOW listen_addresses'
   ```

   It should print `localhost` (or `127.0.0.1`). If it prints `*`, set `listen_addresses = 'localhost'` in
   `postgresql.conf` (find it with `sudo -u postgres psql -tAc 'SHOW config_file'`) and restart Postgres
   with `sudo systemctl restart postgresql`. A restart briefly disconnects anything else using it.

   **Docker:** leave `listen_addresses` at `*` inside the container (that is the container's own network,
   and `localhost` there would make Postgres unreachable through the published port). What keeps it
   private is publishing the port on the instance's loopback only: `-p 127.0.0.1:5432:5432` (in Compose,
   `"127.0.0.1:5432:5432"`). Check with `sudo ss -ltnp | grep 5432`: it must show `127.0.0.1:5432`, not
   `0.0.0.0:5432`.

5. Allow password logins for the two roles from localhost, to their own database only. Find the file with
   `sudo -u postgres psql -tAc 'SHOW hba_file'`, open it with `sudo nano <that path>`, and add these four
   lines **above** any other `host` lines (the first matching line wins):

   ```
   host    first_twenty  first_twenty,first_twenty_owner  127.0.0.1/32   scram-sha-256
   host    first_twenty  first_twenty,first_twenty_owner  ::1/128        scram-sha-256
   host    all           first_twenty,first_twenty_owner  127.0.0.1/32   reject
   host    all           first_twenty,first_twenty_owner  ::1/128        reject
   ```

   Then reload Postgres (no disconnects): `sudo systemctl reload postgresql`.
   Amazon Linux ships `ident` on its default `host` lines, which rejects passwords; your lines above
   them take care of that. The two `reject` lines keep both roles out of every other database on the
   instance: Postgres lets any role connect to a database unless told otherwise, so without them a
   compromised server could read whatever those databases share with everyone. Other logins are not
   affected. An existing setup can add the two `reject` lines below its `first_twenty` lines at any time.

   **Docker:** skip this step. Connections reach the container from the Docker bridge, not from
   127.0.0.1, so these lines would never match; the official image's own `host all all all scram-sha-256`
   line already accepts both roles' passwords.

6. Test both logins. Each asks for that role's password:

   ```bash
   psql "postgres://first_twenty@127.0.0.1:5432/first_twenty" -c 'SELECT current_user'
   psql "postgres://first_twenty_owner@127.0.0.1:5432/first_twenty" -c 'SELECT current_user'
   ```

   They should print `first_twenty` and `first_twenty_owner`. If not, see
   [Password authentication failed](#password-authentication-failed). With Postgres in Docker, install
   the Postgres client on the instance first; the nightly backups need it too, in the same major version
   as the server or newer (see [What runs every night](#what-runs-every-night)).

## Step 2: copy the code and run the setup script

Put the code in your home folder on the instance, then let the setup script install everything and copy
the code to `/opt/first-twenty`.

**Option A: from a private Git repository** (recommended; updates become one command). On the instance,
install git, make a read-only deploy key and add it to the repository:

```bash
sudo dnf install -y git                      # Ubuntu: sudo apt-get install -y git
ssh-keygen -t ed25519 -f ~/.ssh/first_twenty_deploy -N "" -C "first-twenty deploy key"
cat ~/.ssh/first_twenty_deploy.pub
```

Copy the line it prints. On GitHub open the repository, then Settings > Deploy keys > Add deploy key,
paste it and leave "Allow write access" off. Back on the instance:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/first_twenty_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
chmod 600 ~/.ssh/config
git clone git@github.com:your-company/first-twenty.git ~/first-twenty
```

The first time, ssh asks whether to trust github.com; type `yes`.

**Option B: copy it from your computer** (no Git hosting needed). On your computer:

```bash
git archive --format=tar.gz -o first-twenty.tgz HEAD
scp -i your-key.pem first-twenty.tgz ec2-user@hr.example.com:~
```

Then on the instance:

```bash
mkdir -p ~/first-twenty && tar -xzf ~/first-twenty.tgz -C ~/first-twenty
```

(`git archive` packs committed files only; commit first.)

**Run the setup script** with your domain, and optionally an email for certificate notices:

```bash
sudo bash ~/first-twenty/server/deploy/setup-ec2.sh --domain hr.example.com --email you@example.com
```

For careers pages, add `--careers-domain careers.example.com` (repeat it for more host names); you can
also add them later. See [Careers pages](#careers-pages).

On an instance with under 2 GB of memory (a t3.micro has about 900 MB), setup adds a 2 GB swap file at
`/swapfile`, so `npm ci` and the build fit. The swap file sits on the same disk as Postgres and every
database on it, so setup first checks that the disk keeps 1 GB free on top of the swap file, and skips it
with a warning when it would not (a 20 GB disk with 17 GB free has plenty of room). If making it fails
part way, setup removes the unfinished file. `--swap 1G` picks another size, and `--no-swap` skips it.

On a brand-new instance with no Postgres yet, `--install-postgres` installs it from the OS packages (then
go back to step 1). The script never installs, upgrades or reconfigures a Postgres that already exists,
and never creates, changes or drops a database or role. It only looks whether the `first_twenty`
database and its two roles exist, and says so (then skip step 1).

It prints each step as it goes and finishes with the remaining steps. Here is what it leaves behind:

| Where | What |
|---|---|
| `/opt/first-twenty` | The code (with `.git` when you cloned, so `git pull` works there). Owned by your login; the service can read it but not change it. |
| `/etc/first-twenty/env` | The server's settings, readable only by root. Created from `.env.example` once and never overwritten. |
| `/etc/systemd/system/first-twenty.service` | The service, enabled to start on boot. It runs as the `firsttwenty` system user, which cannot log in. |
| `/etc/caddy/Caddyfile` | Your site (and one per careers host): https, `http://` redirected to it, and read timeouts so a client that sends a request a byte at a time cannot hold connections open (3 minutes for a whole upload, 15 seconds for the headers). A Caddyfile you wrote yourself is left alone; the site goes in `/etc/caddy/first-twenty.caddy` and the script tells you the one `import` line to add, and to copy the timeouts (the global options block) to the top of yours. |
| `/etc/apt/apt.conf.d/51first-twenty` | Ubuntu only: automatic Node.js updates and reboots (see [Keep it patched](#keep-it-patched)). Written once and never overwritten. |
| `/usr/local/sbin/first-twenty-backup` and the `first-twenty-backup.timer` | The nightly backup. |

Then delete the copy in your home folder, so the only code on the instance is the code the service runs:

```bash
rm -rf ~/first-twenty ~/first-twenty.tgz
```

From now on you work in `/opt/first-twenty`. `deploy.sh` refuses to run from any other folder.

## Step 3: fill in the settings file

```bash
sudo nano /etc/first-twenty/env
```

Replace `CHANGE_ME` in the two connection lines with the passwords from step 1: the `first_twenty`
password in `DATABASE_URL`, the `first_twenty_owner` password in `MIGRATION_DATABASE_URL`:

```
DATABASE_URL=postgres://first_twenty:server-role-password@127.0.0.1:5432/first_twenty
MIGRATION_DATABASE_URL=postgres://first_twenty_owner:owner-role-password@127.0.0.1:5432/first_twenty
```

Check that `PUBLIC_ORIGIN` is `https://` plus your domain. Setup sets it when it creates the file; when
you re-run setup with another domain it keeps the file, warns, and prints the one command that sets it.
Leave everything else as it is; each line has a comment saying what it does. (The comment near the top
of the file mentions `CHANGE_ME` as an example; that one stays.) Only for a server that is meant to be a
public demo, also set `SIGNUP_MODE=open` (see [A public demo server](#a-public-demo-server)). Save with
Ctrl+O, Enter, Ctrl+X.

If your password has characters other than letters and digits, percent-encode them in the URL: `@` is
`%40`, `:` is `%3A`, `/` is `%2F`, `#` is `%23`, `%` is `%25`.

The file is readable only by root because it holds the database passwords. systemd reads it when it
starts the service and passes everything except `MIGRATION_DATABASE_URL` to the server; `with-env.sh`
reads it (through sudo) when you run a command that needs it.

### If your database and roles already exist

When `postgres-setup.sql` already ran on this instance (setup prints "The first_twenty database and its
two roles already exist"), skip step 1. Setup left the database, both roles and every other database on
the instance exactly as they were. If you are not sure the `pg_hba.conf` lines from step 1.5 are in
place, check them; the rest of step 1 is done.

Give both roles new passwords now, made and set on the instance, so the only copy of each is in
`/etc/first-twenty/env` and a password that was ever made or pasted on another computer stops working.
For each role in turn:

1. Make a password and leave it on screen:

   ```bash
   openssl rand -base64 33 | tr -d '/+=\n'; echo
   ```

2. Set it. psql asks for it twice without showing it, and sends Postgres only a hash, so the password
   is not in your shell history or the Postgres log:

   ```bash
   sudo -u postgres psql -c '\password first_twenty'
   ```

3. Put it in `DATABASE_URL` in place of `CHANGE_ME` (or the old password) with
   `sudo nano /etc/first-twenty/env`.

Then do the same for the owner, `sudo -u postgres psql -c '\password first_twenty_owner'`, and put
that password in `MIGRATION_DATABASE_URL`. When both are in, run `clear` so they leave the screen, and
do not paste them anywhere else. If one is ever lost, set a new one the same way.

Check both after the build in step 4:

```bash
bash server/deploy/with-env.sh npm run server:migrate -- --status
sudo systemctl restart first-twenty
curl -s http://127.0.0.1:8787/api/health
```

The first command logs in as `first_twenty_owner` and lists `001_init.sql` and
`002_history_and_seq_versions.sql` as applied (anything newer shows as pending until `server:migrate`
runs). The health check logs in as `first_twenty` and should say `"db":"up"`. Restart the service
whenever you change `DATABASE_URL`: a running server keeps using its old connections until then. If the
tables turn out to belong to another role (`sudo -u postgres psql first_twenty -c '\dt'` shows the
owner), see [Migrations](#migrations).

## Step 4: build, create the tables and your admin login

Run these as your normal login (not with sudo), in `/opt/first-twenty`:

```bash
cd /opt/first-twenty
npm ci
npm run build:all
bash server/deploy/with-env.sh npm run server:migrate
bash server/deploy/with-env.sh npm run server:create-admin -- --email you@company.com
```

- `npm ci` installs the exact dependencies from `package-lock.json`.
- `npm run build:all` builds the one-file app (`first-twenty.html`) and the server (`dist-server/`).
  It takes a few minutes.
- `server:migrate` creates the tables, as `first_twenty_owner` (`with-env.sh` swaps in
  `MIGRATION_DATABASE_URL` for this command only). It is safe to run any time; it only applies what is
  missing.
- `server:create-admin` asks for the admin password twice, without showing it. Use a password manager to
  make a long one. Running it again later changes the email or password and signs out every session.
- **Pick a login email that is published nowhere**, for example `ops-7k2q@yourcompany.com` instead of
  your address from the company website. The server never sends mail to it, so it only has to look like
  an email address. Anyone who knows the login email can use up its 100 failed sign-ins per 15 minutes
  from a handful of addresses, and then every browser that has not signed in before is refused (see
  [Sign-in says rate_limited everywhere](#sign-in-says-rate_limited-everywhere)).

## Step 5: start the server and check it

```bash
sudo systemctl restart first-twenty
sudo systemctl status first-twenty --no-pager
curl -s http://127.0.0.1:8787/api/health
curl -s https://hr.example.com/api/health
```

Both `curl` lines should print something like `{"ok":true,"db":"up","version":"0.1.0"}`. The first
HTTPS request can take a few seconds while Caddy gets the certificate. If the first works and the second
does not, see [The site does not load over HTTPS](#the-site-does-not-load-over-https).

## Step 6: open the app and upload your workspace

Open `https://hr.example.com`. The server serves the same app you already use.

Your current data is still in the browser where you have been using First Twenty (the double-clicked
`first-twenty.html` file, or `npm run dev`). Each address keeps its own browser storage, so the new
address starts out with the sample company. To move your data across:

1. In the place you have been using, open **Settings > Data** and download a backup.
2. At `https://hr.example.com`, open **Settings > Server**, sign in with the admin email and password,
   and choose **Import a backup** (it opens **Settings > Data**; pick the file you downloaded). After the
   import the app comes back to **Settings > Server**.
3. Choose **Upload this browser's workspace**.

**Keep me signed in on this device** (off by default) decides how long the sign-in lasts: off, the session
ends when the browser closes and after 12 hours at most; on, it lasts up to `SESSION_MAX_DAYS` (7 days).
Either way it ends after 12 hours unused. On a shared computer, finish with **Sign out and remove data**.

From then on every change syncs, and the header shows a sync status (Synced, Syncing, Offline, Signed
out, Needs attention or Paused) that links to **Settings > Server**. On another computer, open the same
address, sign in from **Settings > Server** and choose **Use the server's copy**. The sample company never
syncs, so nothing fictional ends up in your database.

Opened from the `first-twenty.html` file or as a claude.ai artifact, **Settings > Server** only explains
the server: syncing works when the app is opened from your First Twenty server's address.

## Updating

With automatic deploys set up, the server runs `deploy.sh` itself for every release the product owner
publishes (see [Automatic deploys from GitHub](#automatic-deploys-from-github)). By hand, or without them,
when there is new code, run on the instance:

```bash
cd /opt/first-twenty
bash server/deploy/deploy.sh
```

It pulls the latest commits, runs `npm ci`, builds, and asks the database which migrations it does not
have yet. When there are any, it first takes a backup with the nightly backup service
(`sudo systemctl start first-twenty-backup`, which waits until the dump is written) and prints the
dump's file name; if the backup fails it stops before changing anything. When the dump was written and
checked but a later step failed (the copy to S3, with `BACKUP_S3_URI` set), it goes on with that local
dump and warns, pointing to `sudo journalctl -u first-twenty-backup`. Then it applies the migrations,
restarts the service and checks `/api/health` locally and through Caddy. If any step fails it stops
there, and the running server keeps the version it already loaded. It checks Caddy only when
`PUBLIC_ORIGIN` is an `https://` address, and warns when it is not (still the placeholder, or
`http://localhost:8787` from testing through an SSH tunnel).

`deploy.sh` refuses to run from any other folder than the one the service runs its code from
(`/opt/first-twenty`). Run from an old copy such as `~/first-twenty`, it would migrate the database and
then restart the service on the code it still has.

`--skip-backup` migrates without the fresh backup. Use it only when you have just taken one yourself,
for example on a setup made with `--no-backups`.

Without Git hosting, copy a fresh archive and point the script at it (on your computer):

```bash
git archive --format=tar.gz -o first-twenty.tgz HEAD
scp -i your-key.pem first-twenty.tgz ec2-user@hr.example.com:~
ssh -i your-key.pem ec2-user@hr.example.com "cd /opt/first-twenty && bash server/deploy/deploy.sh --archive ~/first-twenty.tgz"
```

When the new server does not report healthy, `deploy.sh` prints the way back:

- **No migration ran:** `git checkout <previous commit>` and `bash server/deploy/deploy.sh --no-pull`,
  with the commit it started from filled in. The database needs no restore.
- **Migrations ran:** migrations only move forward, so the previous code may not work with the changed
  database. The script prints every command with the commit and the file name of the backup it took just
  before migrating filled in: stop the server, check out and build the previous commit, then restore that
  dump as in [Restore a backup](#restore-a-backup), steps 3 to 6. The backup was taken right before the
  migration, so it misses at most the edits made in the few seconds the migration took.

To go back later, after a release that seemed fine, find the dump from just before the update with
`sudo ls -lh /var/backups/first-twenty` (it is named by the time `deploy.sh` ran, in UTC) and follow the
same steps. Edits made since that dump are not in it; see [Restore a backup](#restore-a-backup) for what
happens to them.

That checkout leaves Git on a fixed commit rather than a branch, so a plain `deploy.sh` cannot pull
until you go back to the branch. When the fix is ready, run:

```bash
cd /opt/first-twenty
git switch main          # or the branch you deploy from
bash server/deploy/deploy.sh
```

(`deploy.sh` notices a rolled-back checkout and prints this instead of a confusing `git pull` error.)

After editing `/etc/first-twenty/env`, apply it with `sudo systemctl restart first-twenty`.

When an update changes `server/deploy/first-twenty.service`, `deploy.sh` warns that the installed unit
differs. Apply it by running setup again (`sudo bash server/deploy/setup-ec2.sh hr.example.com`; it only
changes what differs and never touches your settings file or Postgres). The same goes for an update to
`server/deploy/Caddyfile`: setup rewrites `/etc/caddy/Caddyfile` from it and reloads Caddy.

## Automatic deploys from GitHub

Once the code lives in the public team repo, the server can deploy itself: a **staging** copy that follows
`main`, and the **live** server that follows the product owner's GitHub releases. Nothing reaches into the
instance from outside. Every 5 minutes two systemd timers on the instance ask GitHub what is new, over
HTTPS, with no token and no deploy key, so SSH stays open to the product owner's address only.

| | Staging | Live |
|---|---|---|
| Address | `https://staging-77-112-161-54.sslip.io` (change it with `--staging-domain`) | your domain, as before |
| What it deploys | the newest commit on `main`, once its `verify` check passed | the newest GitHub release published by `unique-name27`, once the `verify` check of its commit passed |
| Runs as | `first-twenty-staging`, a system user with no login | the login that owns `/opt/first-twenty` (ubuntu), as `deploy.sh` always has |
| Code and settings | `/opt/first-twenty-staging`, `/etc/first-twenty-staging/env` | `/opt/first-twenty`, `/etc/first-twenty/env` |
| Server | `first-twenty-staging` on 127.0.0.1:8788 | `first-twenty` on 127.0.0.1:8787 |
| Database | `first_twenty_staging`: demo data only, no backups | `first_twenty`: backed up before every migration, and every night |
| Pause it | `sudo touch /etc/first-twenty-staging/autodeploy.paused` | `sudo touch /etc/first-twenty/autodeploy.paused` |
| Logs | `sudo journalctl -u first-twenty-autoupdate-staging` | `sudo journalctl -u first-twenty-autoupdate-live` |

### Set it up (once)

On the instance, from a fresh copy of `main` (the live checkout may still hold older code):

```bash
git clone --depth 1 https://github.com/unique-name27/first-twenty-team.git ~/ft-setup
sudo bash ~/ft-setup/server/deploy/setup-auto-deploy.sh --dry-run
sudo bash ~/ft-setup/server/deploy/setup-auto-deploy.sh
rm -rf ~/ft-setup
```

`--dry-run` prints every step and changes nothing; read it first. Without it, setup:

- installs the updater, `server/deploy/auto-update.sh`, as `/usr/local/bin/first-twenty-autoupdate`;
- for staging: creates the `first-twenty-staging` user, the `first_twenty_staging` database and its two
  roles (with `postgres-setup.sql` and the staging names, so the same limits and grants as live), generates
  their passwords and writes them only into `/etc/first-twenty-staging/env` (root only), adds `pg_hba.conf`
  lines that keep the staging roles in their own database (after a backup of the file), clones the repo into
  `/opt/first-twenty-staging`, installs the staging units and the sudo rule, and adds the staging site to
  Caddy (`/etc/caddy/first-twenty.d/staging.caddy`, imported by one line it adds to `/etc/caddy/Caddyfile`
  after a backup; it checks the result with `caddy validate` before Caddy reloads, and puts everything back
  if it does not validate). Then it starts the first staging deploy;
- for live: switches the origin of `/opt/first-twenty` to `https://github.com/unique-name27/first-twenty-team.git`,
  records the commit checked out there now as deployed (so nothing happens until a newer release exists), and
  turns on the live timer.

`--staging-only` or `--live-only` sets up one of the two. `--release-author` names another GitHub login
whose releases go live, and `--deploy-user` another login for the live channel. It never touches the live
database, its roles, `/etc/first-twenty/env` or the live Caddy sites. Run it again (from a fresh copy of
`main`) when an update changes the updater, the units or `staging.caddy`; the updater's log says when.

### Staging: main after CI

Every merge to `main` runs CI. Within 5 minutes of its `verify` check passing (only a check reported by
GitHub Actions counts), staging fetches that exact commit, builds it (a few minutes on a t3.micro), applies
its migrations, restarts and checks `/api/health`. It is a public demo: open sign-up with demo limits (50
demo companies, deleted after 7 days without activity, 256 MB of records in all), no assistant and no
careers pages. Use demo data only.

It runs `deploy.sh --instance staging` as `first-twenty-staging`, which owns the staging code and nothing
else: it cannot read the live code, settings or backups, and its database roles cannot reach any database
but `first_twenty_staging` (nor can the live roles reach it). It may run exactly two commands with sudo,
written in `/etc/sudoers.d/first-twenty-staging`: starting `first-twenty-staging-migrate` (migrations as the
schema owner, whose password only root can read) and restarting `first-twenty-staging`. The install is
`npm ci --ignore-scripts`: the only install script in `package-lock.json` is esbuild's, which tsx uses in
development, and the build needs none (Vite, Tailwind and Lightning CSS load their native builds without
one). The staging server runs with the live server's sandbox, a smaller share of CPU and a memory cap, so
the live server wins when the instance is busy, and the two channels never build at the same time.

### Live: the product owner's releases

To release, publish a GitHub release (the product owner, `unique-name27`):

1. On GitHub, open the repo, then **Releases** > **Draft a new release**.
2. **Choose a tag**: type a new one, such as `v2026.11.04`, with **Target** `main`. Tags use letters,
   digits, dots, dashes and underscores.
3. Give it a title, and **Generate release notes** for the list of merged pull requests.
4. Leave **Set as a pre-release** off, keep **Set as the latest release** on, and click **Publish release**.

Within 5 minutes of that, once the `verify` check of the tagged commit has passed, the live channel fetches
that exact commit, checks it out detached and runs `deploy.sh`: the backup before pending migrations, the
migrations, the restart, the health checks, and the way back printed if the new server is not healthy. It
deploys a release only when all of these hold:

- it was published by `unique-name27` (a release by anyone else is logged and skipped);
- it is not a draft or a prerelease;
- the tagged commit is on `main`, so it went through a reviewed pull request;
- the `verify` check of that commit passed;
- it is newer than what runs now (an older release never rolls the server back by itself).

Team members have write access, so they could publish a release too; the author check stops it from going
live. A tag ruleset on GitHub that lets only the product owner create or move `v*` tags makes that tighter.

### Pauses, retries and GitHub's limits

Pause a channel by creating its pause file (the commands are in the table above); remove the file to resume.
A paused channel asks GitHub nothing. A commit or release that fails to deploy is tried again on the next
runs, 3 times in all; after that the channel waits for a newer commit or release. Each failed run leaves its
unit marked failed (`systemctl --failed` lists it).

GitHub allows 60 requests an hour from one address without a token, shared by both channels. Each run sends
the ETag of the last answer, so an unchanged answer is a short 304. A normal run sends one request, and
asks for check runs only while a new commit's check is unknown (and, after a failed check, at most every 30
minutes, in case CI was re-run): 24 requests an hour when nothing changes, a few more while CI runs.
When GitHub says the limit is used up, the channel waits for the reset. `git fetch` does not count.

Each channel keeps a small state file: `/var/lib/first-twenty-autoupdate/state` (live) and
`/var/lib/first-twenty-staging/autoupdate/state` (staging), with the deployed commit, the commits that
failed and how often, and the ETags.

### Logs

```bash
sudo journalctl -u first-twenty-autoupdate-live -n 100        # what the live channel did, deploy.sh output included
sudo journalctl -u first-twenty-autoupdate-staging -n 100     # the same for staging
systemctl list-timers 'first-twenty-autoupdate-*'             # when each runs next
sudo systemctl start first-twenty-autoupdate-live             # check now instead of waiting
sudo journalctl -u first-twenty-staging -n 100                # the staging server itself
```

### Roll back

**Live.** When the new server is not healthy, `deploy.sh` prints the way back in the live channel's log,
with the previous commit and, when migrations ran, the backup it took just before.

1. Pause the channel, so it stops retrying: `sudo touch /etc/first-twenty/autodeploy.paused`.
2. Follow the steps from the log (`sudo journalctl -u first-twenty-autoupdate-live -n 200`). With no
   migration: `cd /opt/first-twenty && git checkout --detach <previous commit> && bash server/deploy/deploy.sh --no-pull`.
   With migrations, add the restore from [Restore a backup](#restore-a-backup) with the dump it names.
3. Record what runs now: `first-twenty-autoupdate live --record-deployed` (as the deploy login).
4. Delete the bad release on GitHub (its page > **Delete**), or publish a fixed one, then remove the pause
   file. While the bad release is the latest one, the channel would deploy it again.

To go back later, after a release that seemed fine, do the same: pause, check out the commit you want, run
`deploy.sh --no-pull`, record it, and delete the releases after it.

**Staging** holds demo data only. The simplest way back is a pull request that reverts the change; staging
follows `main` once CI passes. To pin staging to an older commit meanwhile, pause it, then:

```bash
sudo -u first-twenty-staging -H bash -c 'cd /opt/first-twenty-staging && git checkout --detach <commit> && bash server/deploy/deploy.sh --instance staging --no-pull'
sudo -u first-twenty-staging first-twenty-autoupdate staging --record-deployed
```

### What staging shares with the live server

The instance, its memory and its disk. Staging runs code from `main` before the product owner releases it,
on the same instance as the live server. Like the live server, the staging server (and its build) can reach
whatever listens on 127.0.0.1, which includes Caddy's admin endpoint (127.0.0.1:2019), and Caddy's admin
API can change the live sites. Every commit on `main` is reviewed, so this is a risk to watch rather than an
open door. A follow-up worth making is moving Caddy's admin endpoint to a Unix socket that only root and
Caddy can open (the `admin` global option); this kit does not change that.

## Keep it patched

The server faces the internet, so its software needs updates, and some of them do not arrive on their own.

**What is automatic (Ubuntu).** `unattended-upgrades` installs Ubuntu's security updates every day.
Setup adds `/etc/apt/apt.conf.d/51first-twenty`, so it also installs Node.js updates from NodeSource
(which it skips otherwise) and reboots at 04:30, after the nightly backup, when an update needs a reboot
(a new kernel, for example). Postgres, the server and Caddy start again on their own. Setup writes that
file only when it is missing, so edit it freely, for example `Automatic-Reboot "false"` to reboot
yourself. Ubuntu 24.04's `needrestart` restarts the server after a Node.js update; check with
`systemctl show -p ExecMainStartTimestamp first-twenty` that it restarted after the last one, or run
`sudo systemctl restart first-twenty`. Caddy depends on where setup got it (`caddy version` and `apt-cache policy caddy` tell you):

- From Caddy's own apt repository, it updates with the rest.
- From the Caddy release package (setup's fallback when that repository refuses downloads, pinned by
  `CADDY_VERSION` at the top of `setup-ec2.sh`), it never updates on its own. Look at
  [Caddy's security advisories](https://github.com/caddyserver/caddy/security/advisories) once a month;
  to update, raise `CADDY_VERSION` (pick a release at least two weeks old) and run setup again. It checks
  the package against the release's SHA-512 checksums and replaces the older Caddy, keeping your
  Caddyfile.
- Ubuntu's own `caddy` package (the last resort; 2.6 on 24.04, in `universe`) misses years of Caddy fixes.
  Run setup again once GitHub is reachable: it replaces any Caddy older than `CADDY_VERSION`.

**Amazon Linux 2023** installs nothing on its own: run `sudo dnf upgrade` monthly, and reboot when it
updated the kernel.

**Once a month**, on the instance:

```bash
sudo apt-get update && sudo apt-get upgrade        # Amazon Linux: sudo dnf upgrade
ls /var/run/reboot-required 2>/dev/null && sudo reboot
systemctl is-active first-twenty postgresql caddy  # after a reboot: all three say active
caddy version                                      # compare with Caddy's security advisories
```

**Before each update of the code**, on your computer: `npm audit --omit=dev`. `deploy.sh` installs with
`--no-audit`, so this is the only place dependency advisories (fastify, pg and the rest) show up. A fix
reaches the server through a commit and `deploy.sh`.

**Node.js 22 reaches end of life on 2027-04-30.** Move to Node.js 24 (supported until 2028-04-30) before
then: run the build and the full test suite on 24 on your computer, change `NODE_MAJOR=${NODE_MAJOR:-22}`
at the top of `setup-ec2.sh` to 24, then on the instance run setup again (it switches the NodeSource
repository when the installed Node.js is older) and `deploy.sh --no-pull`.

## Two database roles

The server's own login, `first_twenty`, can read and write rows but cannot create, change or drop
tables, create functions or schemas, or empty a table with `TRUNCATE`. If the server process were ever
compromised, the damage stays limited to the rows themselves (which nightly backups cover), and the
schema stays intact. The tables belong to `first_twenty_owner`, whose password lives only in
`MIGRATION_DATABASE_URL`:

| Command | Runs as |
|---|---|
| The server (`systemctl start first-twenty`) | `first_twenty` (`DATABASE_URL`). The systemd unit removes `MIGRATION_DATABASE_URL` from its environment. |
| `with-env.sh npm run server:migrate`, also run by `deploy.sh` (with `-- --status` first) | `first_twenty_owner` |
| `with-env.sh npm run server:after-restore` | `first_twenty_owner` (it renumbers every company's changes and ends every session) |
| `with-env.sh npm run server:create-admin` | `first_twenty` |
| The nightly backup, and the one `deploy.sh` takes before migrating | `first_twenty_owner` when `MIGRATION_DATABASE_URL` is filled in, else `first_twenty` |

Because the server's role cannot change tables, keep `MIGRATE_ON_START=false`; migrations always run
through `with-env.sh` or `deploy.sh`. New tables a migration creates are readable and writable by the
server's role automatically (`postgres-setup.sql` sets default privileges for that).

### Upgrading a setup that has one role

Setups made with an earlier version of this kit have only `first_twenty`, which owns the tables. To
split it:

1. Re-run `postgres-setup.sql` as in step 1. It asks only for the new `first_twenty_owner` password, hands
   the existing tables to `first_twenty_owner`, gives `first_twenty` read and write access to them, and
   takes away its right to create tables. Nothing else changes, and no data moves.

   ```bash
   cd /opt/first-twenty
   sudo -u postgres psql -v ON_ERROR_STOP=1 < server/deploy/postgres-setup.sql
   ```

2. In `pg_hba.conf`, change the user column of your two `first_twenty` lines to
   `first_twenty,first_twenty_owner` (step 1.5), then `sudo systemctl reload postgresql`.
3. Add the line `MIGRATION_DATABASE_URL=postgres://first_twenty_owner:owner-role-password@127.0.0.1:5432/first_twenty`
   to `/etc/first-twenty/env` (`sudo nano /etc/first-twenty/env`).
4. Install the updated systemd unit, which hides that line from the server:
   `sudo bash server/deploy/setup-ec2.sh hr.example.com`.
5. Check: `bash server/deploy/with-env.sh npm run server:migrate -- --status` should say it runs as the
   schema owner and list every migration as applied.

Until step 3 is done, `with-env.sh` runs migrations as `first_twenty` and prints a note; after step 1
that fails with `permission denied for schema public`, so do steps 1 and 3 together.

## Backups and restore

### What runs every night

At 03:15 server time (EC2 instances use UTC unless you changed it), `first-twenty-backup` runs `pg_dump`
and writes `/var/backups/first-twenty/first-twenty-YYYYMMDD-HHMMSSZ.dump` (compressed Postgres custom
format, readable only by root). It checks each new dump, then deletes dumps older than 14 days. Old
dumps are removed only after a new one succeeds. `deploy.sh` runs the same service right before it
applies migrations, so an update that changes the database always has a dump from just before.

```bash
systemctl list-timers first-twenty-backup.timer     # when it ran last and runs next
systemctl status first-twenty-backup --no-pager     # "failed" means the last run failed
sudo journalctl -u first-twenty-backup -n 20        # what the last run said
sudo ls -lh /var/backups/first-twenty               # the dumps
sudo systemctl start first-twenty-backup            # take one now
```

Nothing emails you when a backup fails, so check now and then that the newest dump is from last night.
Change the defaults with `BACKUP_DIR` and `BACKUP_KEEP_DAYS` in `/etc/first-twenty/env`.

**pg_dump must be the same major version as your Postgres server, or newer.** An older one stops with
`aborting because of server version mismatch`, every night. When Postgres runs from the instance's own
packages the matching client is already installed. When it runs in Docker (or you upgrade the server),
install the client for that version: find it with `SHOW server_version`, then on Amazon Linux
`sudo dnf install postgresql17` (for 17) and on Ubuntu `sudo apt-get install postgresql-client-17` (from [apt.postgresql.org](https://wiki.postgresql.org/wiki/Apt)
when your Ubuntu release does not have that version). The backup script checks this before it starts and
prints the right package name for your server when the client is missing or too old. To use a client
installed elsewhere, set `PG_DUMP` and `PG_RESTORE` in `/etc/first-twenty/env`.

### Keep a copy off the instance

A dump on the same disk does not survive losing the instance. Add one or both of these:

- **S3.** Create a private bucket (Block Public Access on, default encryption on). Give the instance an
  IAM role that allows `s3:PutObject` on `arn:aws:s3:::your-bucket-name/first-twenty/*` (EC2 console:
  Actions > Security > Modify IAM role). Amazon Linux has the `aws` command already; on Ubuntu install it
  with `sudo snap install aws-cli --classic`. Then set
  `BACKUP_S3_URI=s3://your-bucket-name/first-twenty/` in `/etc/first-twenty/env`. Never put access keys on
  the instance; the role is enough. Add a lifecycle rule on the bucket to expire old copies, for example
  after 90 days. The role can add copies but not list or read them, so someone who breaks into the
  instance cannot read your old dumps from the bucket. You restore a copy from your own computer
  instead (see [Restore a backup](#restore-a-backup)).
- **EBS snapshots** of the whole disk with Amazon Data Lifecycle Manager (EC2 console > Lifecycle Manager).

The app's own backup download (**Settings > Data**) is a third, independent copy you can keep anywhere.

### Prefer cron

Run setup with `--no-backups`, then follow the cron lines at the top of `server/deploy/backup.sh`.
Amazon Linux 2023 has no cron until you install `cronie`.

### Restore a backup

This keeps your current database under another name, so nothing is lost if you pick the wrong file.

```bash
# 1. Pick the dump to restore.
sudo ls -lh /var/backups/first-twenty

# 2. Stop the server so nothing writes during the restore.
sudo systemctl stop first-twenty

# 3. Set the current database aside.
sudo -u postgres psql -c 'ALTER DATABASE first_twenty RENAME TO first_twenty_before_restore'

# 4. Create a fresh, empty first_twenty database with the same permissions (no password prompt this time).
cd /opt/first-twenty
sudo -u postgres psql -v ON_ERROR_STOP=1 < server/deploy/postgres-setup.sql

# 5. Load the dump, owned by first_twenty_owner (the server's role gets read and write access to the
#    restored tables automatically). Replace the file name with yours.
sudo install -m 600 -o postgres -g postgres /var/backups/first-twenty/first-twenty-20261010-031500Z.dump /var/tmp/ft-restore.dump
sudo -u postgres pg_restore --dbname=first_twenty --no-owner --no-acl --role=first_twenty_owner \
  --single-transaction --exit-on-error /var/tmp/ft-restore.dump
sudo rm /var/tmp/ft-restore.dump

# 6. Bring the schema up to date (in case the dump is older than the code), start a new sync history,
#    then start the server and check it.
bash server/deploy/with-env.sh npm run server:migrate
bash server/deploy/with-env.sh npm run server:after-restore
sudo systemctl start first-twenty
curl -s https://hr.example.com/api/health
```

Do not skip `server:after-restore`. The restored database reuses change numbers that browsers already saw
after the backup was taken; without this step a browser that synced in between would skip the restored
server's new changes and could later overwrite them. The step makes every browser reload the server's
copy, and it signs everyone out and forgets every trusted device (the backup may hold sign-ins and
devices that had already ended). The admin password
is the one in use when the backup was taken; run `server:create-admin` again if you had changed it since.

Both step 6 commands run as `first_twenty_owner` through `with-env.sh`, like every maintenance command
that rewrites the whole database.

**Postgres in Docker:** in steps 3 and 4 use `docker exec -i <container> psql -U postgres ...` in place of
`sudo -u postgres psql ...` (no password prompts come up in step 4, so `-i` with `<` is fine there). For
step 5, copy the dump in and restore it inside the container:
`docker cp /var/backups/first-twenty/<file>.dump <container>:/tmp/ft-restore.dump`, then
`docker exec <container> pg_restore -U postgres --dbname=first_twenty --no-owner --no-acl --role=first_twenty_owner --single-transaction --exit-on-error /tmp/ft-restore.dump`
and `docker exec <container> rm /tmp/ft-restore.dump`.

If the rename says the database is being accessed by other users, something else still holds a connection;
close it, or run
`sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'first_twenty'"`
and try again.

**From S3.** The instance's role can only add files to the bucket, so download the dump on your
computer with your own AWS sign-in (the S3 console, or the `aws` command after `aws configure`) and copy
it to the instance. On your computer:

```bash
aws s3 ls s3://your-bucket-name/first-twenty/
aws s3 cp s3://your-bucket-name/first-twenty/<file>.dump .
scp -i your-key.pem <file>.dump ec2-user@hr.example.com:~
```

On the instance, move it into the root-only backups folder, then restore it with the steps above:

```bash
sudo install -m 600 -o root -g root ~/<file>.dump /var/backups/first-twenty/<file>.dump && rm ~/<file>.dump
```

The dump holds your HR data, so delete the copy on your computer when you are done. The other way is to
let the instance read the bucket: add `s3:GetObject` on `arn:aws:s3:::your-bucket-name/first-twenty/*`
and `s3:ListBucket` on `arn:aws:s3:::your-bucket-name` (with an `s3:prefix` condition of
`first-twenty/`) to its role, and `sudo aws s3 cp` then works on the instance. The trade-off: anyone who
gets root on the instance can then read every old dump in the bucket, including data you have deleted
since, which is why the write-only role is the recommended setup.

Changes made after the backup was taken are not in it. After `server:after-restore`, each browser that
was connected reloads the server's copy on its next sync and drops what the restored copy does not have.
An edit still waiting in a browser's queue is sent again: it applies when the record has not changed on
the server since that browser last saw it, and otherwise the server's copy wins and the browser says how
many items it refreshed. If a browser holds recent work you want to keep, download a backup from it
(**Settings > Data**) while the server is still stopped, before step 6, so you can look those changes up
and enter them again.

When everything looks right, remove the set-aside copy:
`sudo -u postgres dropdb first_twenty_before_restore`.

## Develop locally

### With PGlite (no Postgres needed)

PGlite is real Postgres compiled to WebAssembly. With no `.env` file the server uses it automatically and
keeps the data in `.data/pg` in the project folder.

`npm run stack` does all of the below in one command, on a database of its own in `.data/dev` with the
sample company loaded and the browser signed in (`docs/DEV.md`). The steps here run the pieces one by one.

```bash
npm run server:create-admin -- --email you@example.com     # once, for a local login
npm run server:dev                                         # the API on http://127.0.0.1:8787
npm run dev                                                # in a second terminal: the app on http://127.0.0.1:8826
```

The Vite dev server passes `/api` through to the local server, so the app and the API share one address,
just like on EC2. Only one process can open the PGlite folder at a time, so stop `server:dev` before
running `server:migrate` or `server:create-admin`. Delete `.data/` to start over.

### Against the EC2 database, through an SSH tunnel

Postgres stays closed to the internet; the tunnel carries the connection inside SSH. On your computer,
in its own terminal window (leave it open):

```bash
ssh -i your-key.pem -N -L 5433:localhost:5432 ec2-user@hr.example.com
```

Then create `.env` in the project folder (it is git-ignored) with:

```
DATABASE_URL=postgres://first_twenty:your-password-here@127.0.0.1:5433/first_twenty
PGSSLMODE=disable
```

and run `npm run server:dev` and `npm run dev` as above. Port 5433 avoids clashing with a Postgres on your
own computer.

This is your live company data: anything you change locally is real. Use the server's role
(`first_twenty`) here, never the owner: then `npm run server:migrate` from your computer stops with
`permission denied for schema public` instead of changing the production schema, and schema changes
reach production only through `deploy.sh`. Use PGlite for experiments, and delete `.env` (or comment out
the line) when you are done.

## Look at the data in DBeaver

Browse the live data with a read-only login, never the server's or the owner's: `first_twenty_viewer`
can read the companies (`workspaces`), every record table, the documents, the change log and the
assistant's daily counts (`assistant_usage`), cannot read
`users`, `sessions`, `trusted_devices` or `invites` (password and token hashes), and cannot change
anything. On a server that holds more than one company, filter by `workspace_id` (`SELECT id, slug, name
FROM workspaces` lists them; yours is `default`). The ready-made queries in `server/deploy/browse.sql`
already read only `default`.

1. Once, on the instance, from `/opt/first-twenty`:

   ```bash
   sudo -u postgres psql -v ON_ERROR_STOP=1 -f server/deploy/viewer-role.sql
   sudo -u postgres psql -c '\password first_twenty_viewer'
   ```

   The second command asks for the new password twice without showing it. Optionally pin the login to its
   database: add `first_twenty_viewer` to the user column of the `first_twenty` and `reject` lines from
   step 1 in `pg_hba.conf`, then `sudo systemctl reload postgresql`. Run `viewer-role.sql` again after a
   migration adds a table.

2. In DBeaver: **Database > New Database Connection > PostgreSQL**.
   - **Main:** Host `localhost`, Port `5432`, Database `first_twenty`, Username `first_twenty_viewer`,
     the password from step 1. (Host is `localhost` because the connection starts on the instance.)
   - **SSH** tab: **Use SSH Tunnel**, Host the instance's address (the Elastic IP), Port `22`, User
     `ubuntu` (`ec2-user` on Amazon Linux), Authentication **Public Key**, Private key your `.pem` file.
   - **Test Connection**, then **Finish**.

3. Records are JSON in each table's `data` column. `server/deploy/browse.sql` has ready-made queries
   (people, jobs, candidates and applications, offers, pay history, equity, time off, checklists, settings,
   recent changes, the assistant's daily use): open it with **File > Open File**, choose the connection, put
   the cursor in a query and press **Ctrl+Enter**. Double-click a `data` cell to see the whole record.

The app is the source of truth: edits belong in the app, which syncs them. The viewer cannot write, so
nothing done in DBeaver can drift from what the app shows.

## Troubleshooting

Logs first, every time:

```bash
sudo journalctl -u first-twenty -n 50 --no-pager     # the server
sudo journalctl -u caddy -n 50 --no-pager            # HTTPS and the proxy
sudo journalctl -u postgresql -n 50 --no-pager       # Postgres (the unit name can differ on Ubuntu)
```

### 502 Bad Gateway from Caddy

Caddy is up but the server is not answering on `127.0.0.1:8787`.

- `sudo systemctl status first-twenty`. If it is restarting over and over, the server log says why.
  systemd never stops restarting it (5 seconds apart), so it comes back on its own once the cause is gone.
  It prints plain messages for bad settings, for example `DATABASE_URL still contains the CHANGE_ME
  placeholder` (step 3) or `SERVE_APP=true but the app file ... does not exist` (run `npm run build:all`).
- `curl -s http://127.0.0.1:8787/api/health` on the instance. If this works, compare `PORT` in
  `/etc/first-twenty/env` with the `reverse_proxy` line in `/etc/caddy/Caddyfile`.
- A 502 for a few seconds during `deploy.sh` is normal while the service restarts.
- Meanwhile a browser that opened the app from this address before still opens it (the offline worker's
  copy of the page, `/sw.js`) and shows Offline; its changes wait there and sync once the server answers.

### The site does not load over HTTPS

- DNS: `nslookup hr.example.com` must show the Elastic IP. Setup also warns when it does not.
- Security group: ports 80 and 443 open to anywhere (port 80 is needed for the certificate).
- The Caddy log says what the certificate authority answered. After several failures Caddy waits before
  retrying; fix the cause and run `sudo systemctl reload caddy`.

### Password authentication failed

The server log shows `password authentication failed for user "first_twenty"` or similar (or
`"first_twenty_owner"` when `server:migrate` or `deploy.sh` fails).

- The password in `DATABASE_URL` (or `MIGRATION_DATABASE_URL`) is wrong or needs percent-encoding
  (step 3). Set a new one with `sudo -u postgres psql -c '\password first_twenty'` (or
  `first_twenty_owner`), update the file, and for `DATABASE_URL` restart the service.
- `Ident authentication failed` or `no pg_hba.conf entry`: the two lines from step 1 are missing, sit
  below a broader `host` line, or name only `first_twenty` in the user column. Fix them and reload
  Postgres.
- The password was saved before `password_encryption` was `scram-sha-256` (older setups use `md5`).
  Check with `sudo -u postgres psql -tAc 'SHOW password_encryption'`; set it to `scram-sha-256` in
  `postgresql.conf`, reload, and set the password again with `\password`.
- `connection refused`: Postgres is not running or not on port 5432. Check with
  `sudo ss -ltnp | grep 5432`.

### Migrations

- See what is applied and what is pending:
  `bash server/deploy/with-env.sh npm run server:migrate -- --status`
- Each migration file runs in its own transaction, so a failure leaves nothing half done. Fix the cause
  in the message and run `server:migrate` again.
- `permission denied for schema public`: the migration ran as the server's role. Check that
  `MIGRATION_DATABASE_URL` is in `/etc/first-twenty/env` and that `with-env.sh` says `Running
  server:migrate as the schema owner`. If it does and the error stays, the grants from
  `postgres-setup.sql` are missing: run step 1 again; it is safe.
- `must be owner of table ...`: the tables were created by another role (for example by running
  migrations as `postgres`). Re-running `postgres-setup.sql` fixes tables owned by `first_twenty`; for
  any other owner, hand them over as the superuser:

  ```bash
  sudo -u postgres psql first_twenty -c "SELECT format('ALTER TABLE %I OWNER TO first_twenty_owner;', tablename) FROM pg_tables WHERE schemaname = 'public'" -tA | sudo -u postgres psql first_twenty
  sudo -u postgres psql first_twenty -c 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO first_twenty; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO first_twenty'
  ```
- `MIGRATION_DATABASE_URL ... still has the CHANGE_ME placeholder`: put the `first_twenty_owner`
  password in it (step 3).

### The server cannot reach a database on another host

The systemd unit lets the server talk to `127.0.0.1` and `::1` (`IPAddressDeny=any` with
`IPAddressAllow=127.0.0.1/32 ::1/128`), plus only what the assistant needs: the DNS resolver on
`127.0.0.53` and Anthropic's API addresses (see [Lark, the assistant](#lark-the-assistant)). So a
compromised process cannot open a connection to the rest of the internet. It can still reach what listens
on `127.0.0.1`: Postgres (the `reject` lines from step 1.5 keep it to its own database) and Caddy's admin
endpoint on port 2019, which can change Caddy's configuration. Nor does the sandbox stop data leaving in
the server's own answers. If `DATABASE_URL` points at another machine (RDS, a second instance),
connections time out until you allow that address. Add it in a drop-in, which survives re-running setup:

```bash
sudo systemctl edit first-twenty
```

and enter, with your database's private IP address or subnet (names are not resolved here):

```
[Service]
IPAddressAllow=10.0.1.23
```

then `sudo systemctl restart first-twenty`. Use `PGSSLMODE=verify-full` for a remote database. The same
applies to Postgres in Docker only when the Docker daemon runs with `"userland-proxy": false`: then add
the Docker network (for example `IPAddressAllow=172.16.0.0/12`).

### Signed in, but signed out again right away (cookie not set over http)

Over https the sign-in cookie is `__Host-ft_session`, marked Secure: always when `PUBLIC_ORIGIN` starts
with `https://`, and for every request that reaches Caddy over https in any case. Browsers never send a
Secure cookie over plain `http://`. Always open `https://hr.example.com`, never the instance's IP address
or `http://`. The cookie is also limited to its own site: a copy of the app opened from a file or from
`localhost` cannot sign in to the server. Open the app from the server's address. (Through an SSH tunnel
to `http://localhost:8787`, Chrome and Firefox accept the Secure cookie too; other browsers may not.)

To see whether the server counts a browser as signed in, open `https://hr.example.com/api/auth/session`
in it: `{"user":{...}}` when it is, `{"user":null}` when it is not. The app asks the same on every page
load; the answer is never a 401, so a browser that is not signed in shows no errors in its console.
(`/api/auth/me` answers 401 instead and stays for older copies of the app.) Signed in, open
`https://hr.example.com/api/workspace/status` to see whether the server holds a workspace yet:
`{"empty":true}` before the first upload, else its history id and change count. The app asks that,
not `/api/workspace` (which answers 404 while the server is empty), so an empty server logs no errors
either.

On an sslip.io name, if every page of the site fails with an error after you opened another
`*.sslip.io` site, clear the site data for `sslip.io` (see
[A free sslip.io name instead](#a-free-sslipio-name-instead)).

### Sign-in says rate_limited everywhere

Someone is guessing passwords for your login email from many addresses: after 100 failures in 15 minutes
the server refuses every sign-in for that email, so that guessing stays far too slow to work. Browsers
you have signed in from before still get in (each keeps a trusted-device cookie for 180 days, which has a
limit of its own), so try one of those first. Restarting the server does not help: the guessing fills the
limit again in seconds. Give the login a new email that is published nowhere instead (step 4); the new
email starts with clean limits, and the old one stops mattering:

```bash
cd /opt/first-twenty
bash server/deploy/with-env.sh npm run server:create-admin -- --email ops-<something-random>@yourcompany.com
```

It asks for a password (the same one is fine), signs out every session and forgets every trusted device,
so sign in again with the new email.

### Clock skew

Sessions expire by the server's clock (12 hours idle, 7 days at most), and certificates are checked
against your computer's clock.

- On the instance, `timedatectl` should say `System clock synchronized: yes`. EC2 instances sync with
  the Amazon Time Sync Service through chrony by default; if it says no, run
  `sudo systemctl enable --now chronyd` (Ubuntu: `chrony`).
- If your browser shows a certificate date error, check your computer's date and time.

### The build runs out of memory

`npm run build:all` stops with `Killed` or `JavaScript heap out of memory`. Check for swap with
`swapon --show`. Setup adds a 2 GB swap file on its own under 2 GB of memory, unless the disk is short
(it warns "Skipped the swap file"): free some space and run setup again, or run it with `--swap 1G`. On a
larger instance that still runs out, run setup again with `--swap 2G` (it only adds what is missing),
then rerun the build.

### The service cannot read its files

If the server log shows `EACCES` for a file under `/opt/first-twenty`, your login's umask made new files
private. Fix them with `sudo chmod -R g+rX /opt/first-twenty`. `deploy.sh` sets a safe umask for itself.

## What is and is not stored

**On the server, in Postgres:**

- Every record in your workspace, one table per kind (people, comp records, equity grants, jobs,
  candidates, applications, interviews, scorecards, offers, time off, checklists, trainings, policies,
  the activity log, and the rest), plus the single documents (company, settings, equity setup, compliance
  status, inbox snoozes).
- A change log of accepted changes, used to sync browsers. The server removes entries older than 120
  days once a day. When a record is deleted, its earlier entries go at once, leaving only a note that
  it was deleted (without its contents); a full replace (Import, Start fresh) removes every earlier
  entry. Older copies stay in the nightly dumps until those age out (14 days by default) and in S3 for as
  long as your bucket's lifecycle rule keeps them.
- The logins: each one's email, a scrypt hash of its password (never the password itself) and the
  company it belongs to.
- Companies: on your own server, just yours; on a public demo server, every demo company too, each with
  its name, its careers page slug, who signed it up and when it was last used (demo companies are deleted
  after `DEMO_EXPIRE_DAYS` without use).
- Invite links: a SHA-256 hash of each token (never the token), its company, who made it, when it expires
  and when it was used. Expired links are removed a week after they expire.
- Sign-in sessions: a SHA-256 hash of each session token (never the token), with the time, IP address and
  browser name.
- Trusted devices: a SHA-256 hash of each browser's device token and when it expires (180 days after its
  last sign-in). It only lets that browser past the per-email sign-in limit. `server:create-admin` and
  `server:after-restore` forget them all.
- With the assistant on: how many messages each company sent it per day and how many tokens Claude read
  and wrote for them (`assistant_usage`), never what was asked or answered. Conversations stay in the
  browser tab that had them.

**Sent to Anthropic, with the assistant on:** each question, the conversation it belongs to, and the
records the assistant looks up to answer it go to Anthropic's Claude API. How long Anthropic keeps them is
set by your agreement with Anthropic (see its commercial terms and privacy policy). The app says so in the
assistant's panel.

**Never stored anywhere:** the things First Twenty does not collect in the first place (SSNs, dates of
birth, bank details, home street addresses, ID scans, I-9 forms, background check reports, medical
details, salary history, protected characteristics). Server logs never include request bodies, cookies or
passwords.

**Stays in each browser:** display preferences (look, text size, theme, shortcuts) and the sync queue.
Each signed-in browser also keeps a full copy of the workspace so it works offline, so treat a laptop
that has signed in like any device holding HR data: disk encryption on, sign out on shared computers.
A browser that opened the app from your server's address also keeps a copy of the app page itself (the
offline worker's cache), which holds no workspace data.

**Other copies:** nightly dumps in `/var/backups/first-twenty` (and S3 if you set it up), and Caddy's
access log in `/var/log/caddy` (addresses, paths and browser names; no bodies, and Caddy hides cookies).

## Logins and the path to team roles

Your company starts with one login, the admin that `server:create-admin` makes. To add a teammate, open
**Settings > Server**, choose **Invite a teammate** and send them the link: whoever opens it can create a
login in your company (once; the link stops working after it is used, or after 7 days). A company has at
most 20 open links and 50 logins.

Every login can read and change everything in its company. **Viewing as** in the app is still a preview,
not security: it changes what the screen shows, not what the server allows. So:

- Invite only people who may see everything, pay and equity included. Do not invite managers or
  employees who should see less.
- Treat an invite link like a password until it is used: anyone holding it can join.
- To change your admin password, or hand the admin login to someone else, run `server:create-admin` again
  (step 4). It also signs out every session of that login, which is the quickest way to cut off a lost
  laptop. It only ever changes your own company's admin, never a login of a demo company on the same
  server, and it refuses an email that already signs in to another company.
- To remove a teammate, delete their login on the instance (it signs them out everywhere; the changes
  they made stay, without their name):
  `sudo -u postgres psql first_twenty -c "DELETE FROM users WHERE email = 'them@company.com'"`.
- Anyone with SSH access to the instance can read the database, so keep SSH limited to your IP and your
  key to yourself.

The groundwork for team roles is in place: the `users` table has a `role` column (`admin`, `manager`,
`employee`), and every change records who made it. Moving to team roles means:

1. Each login linked to their person record, with password resets.
2. The server enforcing the same access rules the app uses today for its preview, on every read and
   write: employees see their own pay and equity only, hiring managers see their own jobs and candidates,
   and pay fields are removed from what non-admins receive.
3. Optionally, single sign-on with your Google Workspace or Microsoft account instead of passwords.

Until then, keep logins to the people who may see everything.

## A public demo server

Set `SIGNUP_MODE=open` in `/etc/first-twenty/env` (then `sudo systemctl restart first-twenty`) and the
server becomes a public demo: **Settings > Server** offers **Create a demo company** next to Sign in, and
anyone who opens your address can create a login and a company of their own. Many people can use it at
once; each sees only their own company. The app says plainly that it is a demo server, that nobody should
enter real employee or candidate data, and that demo companies are deleted after 30 days without
activity.

**Never open sign-up on a server that holds real data.** Your own workspace stays separate: no demo login
can read or change it, its careers page stays off until you turn it on (Settings > Server), and the demo
limits below keep strangers from filling the disk or the memory it shares with them. But a public sign-up
page invites strangers to your server, and every company on it shares the one database and its backups.

What sign-up does: it creates the login (an admin), a company with the name given, and a slug for its
careers page: the name and six random letters and digits (`acme-robotics-k7m2qx`), so nobody can find a
company, or learn that a name is taken, by guessing. A slug is never handed out twice: when a demo company
is deleted, its slug is set aside for good (the `released_slugs` table), so links to its old careers page
(on job boards, in emails) never start working for whoever signs up next under the same name. The app then
uploads a fresh, empty company. Invite links work in demo companies too, and an admin can see the open
ones and revoke any of them (Settings > Server).

The settings (all in `.env.example`):

| Setting | Default | What it does |
|---|---|---|
| `SIGNUP_MODE` | `closed` | `open` lets anyone create a login and a demo company. `closed` leaves logins to `server:create-admin` and invite links. |
| `DEMO_MAX_WORKSPACES` | `500` | The most demo companies at once. Sign-up says the demo is full beyond it (your own workspace does not count). Only uploaded companies count, plus sign-ups from the last hour, so sign-ups that never upload cannot fill it. |
| `DEMO_EXPIRE_DAYS` | `30` | A demo company with no change and no sign-in for this many days is deleted with everything in it, and one that was never uploaded a day after its sign-up. `0` never deletes. |
| `DEMO_MAX_TOTAL_MB` | `2048` | How much record data the demo companies may hold together. A write past it is refused (`413 workspace_full`). Keep it well under the disk's free space: the change log and the nightly backups take about as much again. |

Limits that keep a t3.micro (1 GB of memory) responsive for everyone:

- **Sign-ups:** 5 tries per address (IPv6: per /64) and 60 companies created from all addresses together,
  per hour. Only sign-ups that create a company count toward the 60, so tries that fail cannot use them up
  for everyone. A hidden form field that people never fill turns away simple bots. Sign-in keeps its own
  limits.
- **Joining with an invite:** the link's token is checked first, against the invite lookup limit (30 per
  address per 15 minutes), so a junk token costs no password work and touches no account limit; a working
  one then allows 5 joins per address per hour. There is no server-wide count for joins (sign-ups cannot use
  it up, and strangers cannot keep teammates out); a company's 50 logins cap them.
- **Per demo company:** 20,000 records (people, candidates, activity rows and the rest together) and 16 MB of
  them, records of 64 KB at most (documents such as Settings keep the usual 256 KB), a change log of one
  row per record (an edit replaces the record's earlier row, and the newest 50,000 rows are kept, pruned in
  the write that passes them), 20 open invite links and 50 logins. An upload is at most 10 MB, as
  everywhere.
- **How fast a demo company writes:** 120 writes a minute and 64 MB an hour. A browser that syncs normally
  sends far less; past it the server answers `429 write_limit` and the browser keeps the changes and tries
  again. A pull sends at most 8 MB at a time.
- **Per company numbering:** every company counts its own change numbers, so nobody can tell from their own
  numbers how busy another company (yours included) is.
- **Housekeeping** runs when the server starts and then once a day: it signs out ended sessions, deletes
  demo companies past `DEMO_EXPIRE_DAYS` and sign-ups never uploaded after a day (each in one transaction:
  records, documents, change log, invites, logins, sessions, trusted devices, then the company, whose slug
  is set aside), prunes change-log rows older than 120 days, and removes invite links a week after they
  expired. The log says how much it removed.

**What a sign-up tells a stranger:** a sign-up, or joining with an invite, with an email that already has a
login anywhere on the server answers that it does (`409 email_taken`), as it must for a person who mistyped.
It takes as long as a success, each address may try 5 times an hour, and one invite link stops working
after 3 such answers, so nobody can test many emails, but a determined person can learn whether one email
(yours included) has a login here. Use a login email for your own workspace that you do not mind being
known to exist, or keep sign-up closed.

Keep one demo company forever (a showcase you return to) by marking it kept, on the instance:

```bash
sudo -u postgres psql first_twenty -c "UPDATE workspaces SET keep = true WHERE slug = 'acme-robotics-k7m2qx'"
```

Delete one at once, setting its slug aside like the expiry does:

```bash
sudo -u postgres psql first_twenty -c "INSERT INTO released_slugs (slug) SELECT slug FROM workspaces WHERE slug = 'acme-robotics-k7m2qx' AND NOT keep ON CONFLICT DO NOTHING; DELETE FROM workspaces WHERE slug = 'acme-robotics-k7m2qx' AND NOT keep"
```

Its records, documents, change log, logins and invites all go with it (the foreign keys cascade), and
browsers signed in to it are signed out.

To close the demo again, set `SIGNUP_MODE=closed` and restart: existing demo logins keep working until
their companies expire, and nobody new can sign up.

## Careers pages

With careers hosts set, every company on the server whose careers page is on gets a public careers page
built from its own records: its open jobs (open, posted and not waiting for approval, the same rule as the
static demo site), each posting exactly as First Twenty writes it (pay range, benefits, Fair Chance and
equal opportunity lines), and an apply form. An application lands in that company's pipeline as a new
candidate in the job's first stage, marked **Inbound: Careers site** on its card and in the candidate list
(and the Source filter has **Careers site**), with the next step "Review application" and the answer as a
note, and every browser signed in to the company receives it like any other change.

**On or off:** demo companies start with their careers page on; your own workspace starts with it off, so
nothing of it is public until an admin turns it on in **Settings > Server** (Public careers page). Turning a
page off takes it down at once: its addresses answer 404 and take no applications.

| Address (on a careers host) | What it shows |
|---|---|
| `https://careers.example.com/` | A short page about the careers pages. It lists no companies. |
| `https://careers.example.com/<slug>/` | A company's careers page. **Settings > Server** shows the link (so does the Hiring page). |
| `https://careers.example.com/<slug>/jobs/<job>` | One open job and its apply form. The job's address is its title and its record id (`senior-engineer-j-3fa9c0b1d2`): after a rename, the old address sends visitors on to the new one, so links already shared keep working. |

Addresses that are nearly right go where they meant to: capital letters in the slug, a trailing slash, the
title alone or the record id alone all send visitors on (`301`) to the job's address, and an address under
a company that has no page there shows that company's own "not found" page.

**Set them up:**

1. Point a DNS `A` record for each careers host at the Elastic IP, as for the app's domain. With
   [sslip.io](#a-free-sslipio-name-instead), `careers-3-14-15-92.sslip.io` (and `jobs-3-14-15-92.sslip.io`
   for a second one) work with no DNS setup; the same caveats apply to those names.
2. Run setup with them. It is safe to run again, from `/opt/first-twenty` once the code lives there:

   ```bash
   sudo bash /opt/first-twenty/server/deploy/setup-ec2.sh --domain hr.example.com \
     --careers-domain careers.example.com --careers-domain jobs.example.com
   ```

   It writes a Caddy site per careers host (https, the `http://` redirect, the app's timeouts and headers,
   a 64 KB body limit, no cookies) and, in a settings file it creates, `CAREERS_HOSTS`. A settings file it
   kept is never changed: setup prints the one command that sets `CAREERS_HOSTS` there. Later runs
   without `--careers-domain` keep the careers sites that `CAREERS_HOSTS` names.
3. Restart the server and check the careers host answers:

   ```bash
   sudo systemctl restart first-twenty
   curl -I https://careers.example.com/
   ```

| Setting | Default | What it does |
|---|---|---|
| `CAREERS_HOSTS` | empty | Host names that serve careers pages, separated by commas. Empty: no careers pages. Never the app's own host (the server refuses to start). |
| `CAREERS_ORIGIN` | `https://` and the first careers host | The address the app builds careers links on. |

**What a careers host answers:** careers pages, the stylesheet and typeface they load, and `robots.txt`,
nothing else, under its name with or without the trailing dot of a fully qualified name. The app, its
offline worker and every `/api` route answer 404 there, and careers pages answer 404 on the app's host. No
cookie is set or read on a careers host: the app's sign-in cookies are `__Host-` cookies of the app's host,
the server ignores any cookie a careers request carries, and Caddy drops any `Set-Cookie` on the way out.
Each careers host's HSTS covers that host alone (nothing uses `includeSubDomains`). Every page sends a
strict Content-Security-Policy (its own stylesheet and typeface only, forms that post back to the same
host, no framing), `nosniff`, a same-origin `Referrer-Policy` and `X-Robots-Tag: noindex`, and every value
from a company's records is escaped. The pages carry no script: the form works without one, and the
server checks what it receives. A live page leaves out the company's headcount, and any fact a demo sign-up
filled in that the company never changed (its headquarters, stage, workweek and founding date).

**The apply form** asks for a name, an email, a phone number (optional), a link (LinkedIn, a portfolio or
a resume; optional; plain `http` or `https` addresses only) and an answer to one question about the role.
It never asks for pay history or criminal history, and there is no file upload. Every page says that this
is a demo server where anyone can create a company, so a company or job there may not be real, and the
form says where the application goes. After a send, the confirmation takes focus and is announced; a form
with problems comes back with them listed first, focused and announced, and what was typed kept. The
confirmation's address carries proof of the send that works for 15 minutes, so nobody can send a link that
claims someone applied. Limits that keep it from being used to flood a company:

- 30 form posts and 5 applications per address (IPv6: per /64) an hour, and 100 applications per company
  a day. An application takes its place in both the moment it passes its checks, before the database is
  asked anything, so posts sent all at once cannot get past them. They live in the server's memory, so a
  restart resets them. A post refused by them gets the form back with what was typed and when to try
  again.
- The form takes 32 KB at most, every field has a length limit, a hidden field that people never fill
  turns away simple bots, and a form posted from another site (or a sibling host under the same domain)
  is refused.
- The same email applying to the same job again adds nothing, and the answer is the same; it counts toward
  the limits like a new application, so neither the answers nor the limits tell anyone whether an address
  applied before.
- Applications count toward a demo company's records and bytes, and never as the company being in use: a
  demo company nobody signs in to still expires.

What a page view costs is capped too: a page reads at most 200 open roles and 2 MB of job records, and of
everything else only what those jobs name (their teams, locations and pay bands), whatever the company
holds. Pages are built per request from the company's records and kept in memory until its next change,
up to 32 MB of pages in all (the companies viewed least recently go first), so a page view costs one small
database query. Only two companies' records are read at once; more wait their turn, and past 32 waiting a
page view gets a short "busy" page instead.

**Turn them off** by emptying `CAREERS_HOSTS` and restarting, then run setup again without
`--careers-domain` to remove the careers sites from Caddy.

The static demo site (`npm run build:careers`, the fictional sample company, a form that sends nothing) is
separate. Both come from the same renderer (`src/careers/render.ts`) and stylesheet
(`src/careers/careers.css`).

## Lark, the assistant

First Twenty has an HR assistant: **Ask Lark** in the app's header (or its keyboard shortcut) opens a panel
where anyone signed in to the company asks in plain words, for example "Who starts next week?", "Which legal
deadlines are overdue?", "Where does the senior engineer search stand?" or "Draft a job posting for a
founding designer". It answers from the company's own records, links each person, job or candidate it names
to its page in the app, explains the federal, California and San Jose rules the app tracks with their
official sources, and drafts text to copy. It cannot change anything: it reads, it never writes.

**Its name.** The sample company calls it Lark. A company names it in **Settings > Company** (Assistant
name, up to 40 characters); left empty, it is the company's name and "Bot" (**Quillfin Bot**). The name
syncs with the other company settings.

**Where it runs.** On a First Twenty server with the assistant turned on. Opened from the
`first-twenty.html` file, a claude.ai artifact or GitHub Pages, the panel explains that it works when the app
is connected to such a server, and links to the demo sign-up on the public demo server
(`https://hr-77-112-161-54.sslip.io/#settings.server.signup`); that link shows the assistant only once the demo
server runs a build with it, its key and the updated systemd unit (see Turn it on). Behind it is Anthropic's Claude API (Claude Opus 5.5 by default): each
question, the conversation so far and the records the assistant looks up for it go to Anthropic, and the
panel says so to everyone who uses it. Conversations are kept only in the browser tab (until it closes);
the server stores how many messages each company sent per day and the tokens they used, never the
questions or the answers.

### Turn it on

1. In the Claude Console (`https://console.anthropic.com`), create an API key, and set a monthly spend
   limit for the organization in its limits settings, so a busy demo can never run up a surprise bill.
2. Put the key in the settings file. The simplest way asks for it without showing it, saves it and
   restarts the server (from `/opt/first-twenty`, in an interactive terminal):

   ```bash
   sudo bash server/deploy/set-anthropic-key.sh
   ```

   It ends by printing what the server reports, `"assistant":"claude-opus-5-5"` when the key took.
   `--remove` deletes the key and turns the assistant off. By hand instead: `sudo nano /etc/first-twenty/env`
   and add the line `ANTHROPIC_API_KEY=sk-ant-...`, then `sudo systemctl restart first-twenty`.

   The file is readable only by root (mode 600). The server never logs the key, never returns it in an
   answer and never sends it to a browser; only the Claude API client in the server's memory holds it.
3. Let the server reach the Claude API. The systemd unit's network allow list
   (`server/deploy/first-twenty.service`) has, besides loopback, the DNS resolver on `127.0.0.53` (to look
   up `api.anthropic.com`) and Anthropic's published inbound API ranges, `160.79.104.0/23` and
   `2607:6bc0::/48`, from https://platform.claude.com/docs/en/api/ip-addresses (checked 2026-10-11).
   Install the updated unit by running setup again (it only changes what differs):

   ```bash
   sudo bash /opt/first-twenty/server/deploy/setup-ec2.sh hr.example.com
   sudo systemctl restart first-twenty
   ```

   The EC2 security group allows outbound HTTPS by default; if yours limits outbound traffic, allow TCP 443
   to those two ranges.
4. Check: `sudo journalctl -u first-twenty -n 20 --no-pager` shows `"assistant":"claude-opus-5-5"` on the
   line that says the server is listening, and `GET /api/assistant` (signed in) says `"enabled":true`. Ask
   it something in the app.

To turn it off, remove the `ANTHROPIC_API_KEY` line and restart; the panel then says it is off. The network
allowance stays in the unit, unused. To close it as well, add a drop-in (`sudo systemctl edit
first-twenty`) with `[Service]`, then `IPAddressAllow=` (an empty line resets the list) and
`IPAddressAllow=127.0.0.1/32 ::1/128`.

If Anthropic ever publishes new addresses (it says they do not change without notice), add them the same
way, in a drop-in: `IPAddressAllow=<new range>`. Until then the assistant answers "The server could not
reach Claude", and the server log says `assistant request failed` with no HTTP status.

### Settings

All in `.env.example`; restart after a change.

| Setting | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | empty | The Claude API key. Empty: the assistant is off. It is the only credential sent: an `ANTHROPIC_AUTH_TOKEN` in the environment is ignored. |
| `ASSISTANT_MODEL` | `claude-opus-5-5` | The Claude model. It must take `effort` (the current Claude models do; Haiku 4.5 and Sonnet 4.5 do not); with another, every question answers that the assistant is not set up correctly. Requests carry no thinking setting: `claude-opus-5-5` always thinks adaptively, and `ASSISTANT_EFFORT` sets how much. |
| `ASSISTANT_EFFORT` | `low` | How much the model thinks before answering: `low`, `medium`, `high`, `xhigh` or `max`. Higher is slower and costs more. |
| `ASSISTANT_MAX_TOKENS` | `8000` | The most one model turn may write, its thinking included (up to 128,000). Thinking counts toward it, so a higher effort leaves less of it for the answer: a long draft that reaches it stops mid-sentence, and the panel says the answer was cut off. Raise it (with the cost) if that happens often. |
| `ASSISTANT_DAILY_PER_WORKSPACE` | `40` | Messages one company may send per day (UTC). |
| `ASSISTANT_DAILY_GLOBAL` | `600` | Messages every company together may send per day (UTC). |
| `ASSISTANT_FAKE` | off | `1` runs a scripted model instead of Claude, for development (no key needed, nothing leaves the computer). The server refuses to start with it in production. |

### What it costs, and the limits

Claude Opus 5.5 costs $4 per million input tokens, $20 per million output tokens and $0.20 per million input
tokens read from the prompt cache (Anthropic's prices, October 2026). The assistant's instructions and tool
descriptions are cached, so a conversation pays full price for them about once every five minutes. A
typical question (one or two lookups, a short answer) reads 10,000 to 30,000 tokens, most of them from the
cache, and writes 500 to 2,000: a few cents. The `browse.sql` query "The assistant's use per company and
day" shows the real numbers (`assistant_usage`), each kind of token apart as Anthropic bills it: input at
full price ($4 per million), written to the prompt cache ($5) and read from it ($0.20), and output with the
thinking in it ($20), plus `billed_input_tokens`, the three input counts added up (everything Claude read;
`input_tokens` alone is only the uncached part after the last cache point, so it looks small). Most input
should show as cache reads; if it does not, the cache is not working. A turn that failed part way (the
browser left, Claude broke off) is counted too, with what it had used.

What caps it:

- **Messages per day:** `ASSISTANT_DAILY_PER_WORKSPACE` per company and `ASSISTANT_DAILY_GLOBAL` for the
  server, counted when a message starts. The last quarter of the server's count is kept for companies that
  have asked fewer than 5 questions that day, so a few busy companies (or many sign-ups by one person)
  cannot use it up for everyone. A message is given back only when no request went to Claude for it, or when
  the API turned the request away with an error status (which Anthropic does not bill) or could not be
  reached; once a request is out, closing the page does not give the message back, so hanging up early never
  gets past the limits. Past a limit, the app says the questions are used up and when they come back, in the
  person's own time (`429 assistant_quota`). The counts reset at midnight UTC (5 PM in California under
  daylight time, 4 PM in winter).
- **Per message:** at most 8 requests to Claude (each lookup round is one more), each writing at most
  `ASSISTANT_MAX_TOKENS`; every lookup answers with at most 8 KB of records.
- **Per conversation:** 40 messages (each lookup adds two) or 150 KB; then the app asks to start a new one.
  A question is at most 2,000 characters.
- **At once:** one answer at a time per login (`409 assistant_busy`), two per company across its logins
  (`409 assistant_company_busy`), and 8 for the whole server (`503 assistant_full`, try again in a minute), so
  no company can take every slot.

### How it keeps company data safe

- **One company only.** Its lookups read the signed-in login's company and nothing else, whatever a
  question or a request names; the tests check every lookup against another company's records.
- **Records are data, not instructions.** Candidate names, titles and answers come from strangers through
  the careers pages, and anyone could type "ignore your instructions" into one. The assistant is told that
  what its lookups return is data and that instructions in records are never followed; every result with
  candidate text says the same, and record text is cut short. Its lookups only read, so even a successful
  trick cannot change, delete or send anything.
- **An answer cannot become a way out.** The panel shows answers with a small renderer of its own:
  paragraphs, bold, italics, lists, code and links, everything else as plain text. It never shows images or
  HTML, so no answer makes the page fetch an address by itself. Links are followed only to pages in the app
  (never to an action, a form or an invite link, also when written as a full address into the app) and to
  the official sources the assistant's lookups cite (the government and law sites in `src/data/law.ts` and
  the compliance rules), which open in a new tab without a referrer. Any other address, for example one a
  planted instruction got the model to write with salaries in it, shows as text with the site it named
  ("link to evil.example removed") and cannot be clicked. What remains is the text itself: someone who copies
  an odd address out of an answer by hand could still send what is in it, which is why the assistant is
  told never to put record data into an address, and why its lookups only read.
- **What it never does:** rank or score candidates, guess anyone's protected characteristics, or ask for
  SSNs, bank details, medical details or salary history. Time off it reports never names a confidential kind
  (bereavement, reproductive loss).

### How it works

`server/src/assistant/`: `routes.ts` (the two routes), `runner.ts` (one message: the Claude API's tool
runner with streaming), `tools.ts` (the ten read-only lookups, computed with the app's own domain code from
`src/domain`), `reader.ts` (loads one company's records), `prompt.ts`, `history.ts` (checks the conversation
a browser sends back), `quota.ts`, `law.ts` (the verified facts from `src/data/law.ts` and the compliance
rules) and `fake.ts` (`ASSISTANT_FAKE`). The protocol is in `docs/SYNC.md` (`/api/assistant`).

- The browser sends the whole conversation with each question, exactly as the server returned it last time,
  and the server checks it (user and assistant turns only, text and the assistant's own lookups, nothing
  that could pull in images, documents or other sites) and never changes it: the model's thinking is tied to
  the exact conversation that produced it.
- Answers stream back as server-sent events (`delta` text, `status` while a lookup runs, `discard` when a
  turn is asked again, then `done` with the conversation, or `error`). Caddy passes them through as they
  arrive: the stream is marked `Cache-Control: no-store, no-transform`, so Caddy's compression leaves it
  alone, and nothing in the Caddyfile needs changing. When the browser goes away, the server stops the
  request to Claude (the message still counts if the request was out).
- Requests leave the thinking setting out (on `claude-opus-5-5` adaptive thinking is the only mode) and set
  `ASSISTANT_EFFORT`, cache the instructions and tool descriptions, and turn on Anthropic's server-side
  refusal fallback (`fallbacks: "default"`), which retries a request a safety classifier declined on the
  model Anthropic recommends for it. When that happens part way through an answer, the turn goes back into
  the conversation the way Anthropic's docs say: the declined model's text stays, its thinking and
  half-made lookups are left out, and those lookups never run.
- The model's thinking is tied to the instructions and the conversation it was written under, so neither
  ever changes under a running conversation: the instructions are the same for every company and day, and
  the assistant's name, the company and today's date go into the conversation as a short note before the
  first question, and again before a question when one of them changed (a new day in California, a rename).
  An update that edits the instructions or a lookup does change them: a conversation started before it
  can then be refused by the API at its next question, and the panel asks to start a new conversation
  (`bad_conversation`).

### Develop with it

`ASSISTANT_FAKE=1 npm run server:dev` (or the line in `.env`) runs a scripted model: a question that
mentions who, people or start looks people up for real and answers with a link to the first one; anything
else is echoed. No key, nothing leaves the computer. With a real key in `.env` instead, development talks to
Claude like the server does (the sandbox is a production matter: development has no network allow list).

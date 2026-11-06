# Comment server for the Region VII Scene Guide

## What this is

The page used to send every comment to crudcrud.com, a free public test site. The address was in the
page source, so anyone could read, change or delete every comment, and anyone could post a comment
containing code that would then run in every visitor's browser.

This folder is a small comment server of your own that runs free on Cloudflare Workers:

| Who | What they can do |
| --- | --- |
| Anyone | Leave a comment (name up to 60 characters, comment up to 1000, at most 5 per 10 minutes from one visitor). |
| Anyone | Read the comments **you approved**, for the protocol they are looking at. |
| Only you, with your admin key | See every comment, tick **Show on page**, tick **Resolved**, or **Delete**. |

What changes for visitors: a new comment no longer shows to everyone straight away. It waits until you
tick **Show on page** on the Comment review page. If you would rather have comments show straight away,
change `AUTO_APPROVE = "false"` to `"true"` in `wrangler.toml` and run `npx wrangler deploy` again; you can
still hide or delete any comment.

Your admin key lives only in Cloudflare (as a secret) and in your password manager. It is never in the
page or in this repository. On the Comment review page you type it once; the page forgets it when you
close the tab.

## Set it up (Windows PowerShell, about 15 minutes)

You need: Node.js, git, and a free Cloudflare account.

1. **Check Node.js.** Open PowerShell and run:

   ```powershell
   node -v
   ```

   If it says "not recognized", install it, then close and reopen PowerShell:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

2. **Make a free Cloudflare account** at https://dash.cloudflare.com/sign-up if you do not have one.

3. **Get this code and install the tools:**

   ```powershell
   cd C:\Users\xaren
   git clone https://github.com/xarendovich/region-vii-scene-guide
   cd region-vii-scene-guide
   git checkout claude/project-thread-13uz7c
   cd comments-server
   npm install
   ```

4. **Sign in to Cloudflare.** This opens your browser; click Allow.

   ```powershell
   npx wrangler login
   ```

5. **Make the database.**

   ```powershell
   npx wrangler d1 create region7-comments
   ```

   It prints a line like `database_id = "1234abcd-..."`. Open the settings file:

   ```powershell
   notepad wrangler.toml
   ```

   Replace `REPLACE_WITH_DATABASE_ID` with that id. While the file is open, check that
   `ALLOWED_ORIGINS` is the address where the page lives (for GitHub Pages that is
   `https://xarendovich.github.io`; only the start of the address, no path). Save and close Notepad.
   Then create the table:

   ```powershell
   npx wrangler d1 execute region7-comments --remote --file=schema.sql
   ```

6. **Make your admin key.** This makes a long random key, stores it in Cloudflare, and puts a copy on
   your clipboard. Paste it straight into your password manager (KeePassXC) as "Region 7 comments admin key".

   ```powershell
   $b = New-Object byte[] 32
   [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   $key = [Convert]::ToBase64String($b)
   $key | npx wrangler secret put ADMIN_KEY
   Set-Clipboard $key
   Remove-Variable key, b
   ```

7. **Start the server.**

   ```powershell
   npx wrangler deploy
   ```

   It prints an address like `https://region7-comments.YOURNAME.workers.dev`. Send that address to
   Claude in the project thread; it goes into one line of `index.html`
   (`const COMMENT_SERVER = '...'`), and then the pull request is ready for you to merge.

8. **Check it.** After the page update is live, open a protocol, leave a test comment, then open
   **Comment review** on the home page, paste your key, tick **Show on page**, and go back to the
   protocol: your comment shows. Delete the test comment when done.

## If something goes wrong

- **"Comments are switched off for now"** on the page: the page does not have the server address yet (step 7).
- **"That key did not work"** on Comment review: paste the key from your password manager again. To make a
  new key, repeat step 6 (the old one stops working).
- **Comments do not post:** the page address in `ALLOWED_ORIGINS` (step 5) does not match where the page
  is opened. Fix it, then run `npx wrangler deploy` again.

## The old comments on crudcrud.com

Comments posted before this change are still on crudcrud.com, readable by anyone with the address in
the page's history. To keep a copy and then remove them, run this in PowerShell (the second command
deletes them for good, so run it only after checking the backup file):

```powershell
$u = "https://crudcrud.com/api/d2465c7a033948ea963ca1f981fcde00/comments"
Invoke-RestMethod $u | ConvertTo-Json -Depth 5 | Out-File C:\Users\xaren\r7-old-comments.json
(Invoke-RestMethod $u) | ForEach-Object { Invoke-RestMethod "$u/$($_._id)" -Method Delete }
```

crudcrud also wipes free endpoints on its own after a while, so the backup may come back empty.

## For developers

- `src/worker.js` is the whole server; `schema.sql` is the table.
- `npm test` runs the checks in `test/worker.test.mjs` against a local copy (no Cloudflare account needed).
- `node test/serve-local.mjs http://127.0.0.1:8000 <key>` runs a local server on port 8787 for trying the page.

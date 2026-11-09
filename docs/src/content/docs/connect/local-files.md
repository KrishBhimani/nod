---
title: Local files
description: Share folders on the computer Nod runs on, so Nod can list, read, organize and edit files in them and copy files to and from its workspace.
sidebar:
  order: 5
---

Local files lets Nod work with folders on the computer it runs on, for example to tidy your Downloads folder, rename invoices by their content or save a report it made next to your other documents. It works in the desktop app on macOS and Windows and in a source install. A self-hosted server doesn't offer it, because it runs on a different computer than yours.

## Share a folder

Open **Apps** and select **Add folder** on **Local files**. In the desktop app, choose the folder in the folder picker. In a source install, enter the folder's absolute path. Nod checks that it can open the folder before it saves it.

You can share folders inside your home folder, such as Downloads, or on an external drive or other mounted volume (under `/Volumes` on macOS, or a drive other than the system drive on Windows), but not a whole drive. Nod refuses:

- your whole disk, your home folder itself and any folder above it;
- `Library` on macOS and `AppData` on Windows;
- hidden folders, such as `.ssh` or `.config`;
- folders that hold Nod's own data.

Turn on **Read-only** next to a folder to let Nod list, read and copy its files without changing anything there. Adding the same folder again keeps its setting. Select the cross next to a folder to stop sharing it; Nod stops using it at once, even for an action you already confirmed.

On macOS, the first time Nod opens a protected folder, such as Downloads, Documents or Desktop, macOS asks whether Nod may access it. If you declined, allow Nod in **System Settings**, **Privacy & Security**, **Files and Folders**, then add the folder again.

## What Nod can do

| Action        | What it does                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| List          | Lists a folder, newest first, up to 500 entries.                                                                                |
| Read          | Reads up to 256 KB of a text file.                                                                                              |
| Copy to Nod   | Copies a file of up to 90 MB, such as a PDF or a photo, into Nod's workspace so Nod can work on it. Only in work you asked for. |
| Create folder | Creates one folder.                                                                                                             |
| Write         | Creates a text file of up to 1 MB, or replaces one.                                                                             |
| Edit          | Replaces exact text in a text file of up to 1 MB.                                                                               |
| Copy from Nod | Saves a file Nod made in its workspace, such as a report or a converted image, into a shared folder.                            |
| Move          | Moves or renames up to 200 items at once, and never overwrites.                                                                 |
| Trash         | Moves up to 200 items to the Trash or Recycle Bin, where you can restore them.                                                  |

Nod never deletes a file outright. When it replaces or edits a file, the previous version goes to the Trash. Without a Trash Nod can use, it doesn't trash, replace or edit anything. The desktop app uses the system Trash or Recycle Bin; a source install on macOS needs the `trash` command that comes with macOS 15 and later, and a source install on Linux or Windows has none. The previous version goes to the Trash from its own place, so **Put Back** returns it there; if the Trash step fails, nothing changes. On macOS, Nod marks files it writes, edits or copies from its workspace as downloaded when macOS allows it, so macOS checks them before they open.

Each action goes through the same [trust check](/trust/approvals/) as an app action, with the real paths after links are followed. Listing, reading and copying to Nod are reads, so they run without asking. Because Nod's workspace can reach the internet, Nod copies a file into it only in work you started with a message, never in schedules or work it starts on its own. Nod asks before it writes, moves or trashes files your words don't cover.

## Limits

- Nod doesn't see or change hidden files and folders, such as `.env` or `.git`, inside a shared folder. On Windows, `desktop.ini`, `Thumbs.db` and the Recycle Bin count as hidden too; Nod doesn't read Windows' hidden attribute.
- Nod doesn't create programs or shortcuts, such as `.exe`, `.bat`, `.lnk` or `.url` files on Windows or `.command`, `.app` or `.sh` files on macOS, and doesn't rename files into them. It doesn't change executable files either: on macOS and Linux files marked executable, on Windows programs and scripts such as `.exe`, `.bat`, `.ps1` or `.lnk`. Drives formatted as FAT or exFAT, such as many USB sticks, mark every file as executable on macOS, so Nod can list, read, move and trash files there but not write or edit them.
- Every path must stay inside a shared folder after links are followed, so a link that points outside the folder can't be used to reach other files.
- Commands Nod runs in its workspace can't see your folders. Files reach the workspace only when Nod copies them there, and only through this check.
- When you [share conversation traces](/trust/conversation-traces/), the text of files Nod reads is part of them, like any other tool result.

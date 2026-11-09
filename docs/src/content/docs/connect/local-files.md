---
title: Local files
description: Share folders on the computer Nod runs on, so Nod can list, read, write, edit, move and trash files in them.
sidebar:
  order: 5
---

Local files lets Nod work with folders on the computer its server runs on, such as tidying your Downloads folder. It is an early preview.

## Share a folder

Open **Apps** and select **Add folder** on **Local files**. In the desktop app, choose the folder in the macOS folder picker. In a source install, enter the folder's absolute path. Nod checks that it can open the folder before it saves it. You can share folders inside your home folder, such as Downloads, or on an external drive. Your home folder itself, Library, hidden folders in your home folder and folders that hold Nod's own data can't be shared.

On macOS, the first time Nod opens a protected folder, such as Downloads, Documents or Desktop, macOS asks whether Nod may access it. If you declined, allow Nod in **System Settings**, **Privacy & Security**, **Files and Folders**, then add the folder again.

Select the cross next to a folder to stop sharing it.

## What Nod can do

| Action        | What it does                                                    |
| ------------- | --------------------------------------------------------------- |
| List          | Lists a folder, newest first, up to 500 entries.                |
| Read          | Reads up to 256 KB of a text file.                              |
| Create folder | Creates one folder.                                             |
| Write         | Creates a text file of up to 1 MB, or replaces one.             |
| Edit          | Replaces exact text in a text file of up to 1 MB.               |
| Move          | Moves or renames up to 200 items at once, and never overwrites. |
| Trash         | Moves up to 200 items to the Trash, where you can restore them. |

Nod never deletes a file outright. When it replaces or edits a file, the previous version goes to the Trash. Trash, replace and edit need the macOS `trash` command, which comes with macOS 15 and later; without it Nod changes nothing. If moving the old version to the Trash fails after the new one is saved, Nod keeps the old version in a hidden folder next to the file and tells you where. Each action goes through the same [trust check](/trust/approvals/) as an app action, so Nod asks before it moves or trashes files your words don't cover.

## Limits

- Nod doesn't see or change hidden files and folders, such as `.env` or `.git`, inside a shared folder, and it doesn't change executable files such as scripts. Drives formatted as FAT or exFAT, such as many USB sticks, mark every file as executable, so Nod can list, read, move and trash files there but not write or edit them.
- Every path must stay inside a shared folder after links are followed, so a link that points outside the folder can't be used to reach other files.
- The server process reads the files, not the workspace container. Commands Nod runs in its workspace still can't see them.
- In a self-hosted Docker install, the server runs in a container, so it sees that container's files, not your computer's.

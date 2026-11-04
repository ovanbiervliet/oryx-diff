# Contributing to Oryx Diff

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

## Reporting a bug

Open an [issue](https://github.com/ovanbiervliet/oryx-diff/issues) and include:

- What you did, what you expected and what happened instead.
- Your browser and version, and the keyboard model (Voyager, Planck EZ, …).
- The debug text: open the panel, press **?** to show details, open **Debug** and click **Copy debug**. Look through it before pasting and remove anything you don't want to share, such as layout names or revision IDs.

Please don't post layout links or screenshots you want to keep private.

## Suggesting a change

For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend time on it.

## Working on the code

There is no build step, no dependencies and no package manager. The whole extension is `content.js`, plus `manifest.json` and the icons.

1. Fork and clone the repo.
2. Load the folder as an unpacked extension (see [Install](README.md#install)).
3. Edit the files. To try a change, click the reload button (↻) on the extension's card in `chrome://extensions`, then refresh the Oryx tab.

Things to know:

- The script runs inside the Oryx page (`"world": "MAIN"`, only on `configure.zsa.io`). It reuses Oryx's own requests and sends data nowhere else. Please keep it that way: no analytics, no third-party servers, no extra permissions unless there is a strong reason.
- If you change the version, change it in both `manifest.json` and the `VERSION` constant at the top of `content.js`.
- If your change alters what the panel looks like, update the affected screenshots in `screenshots/` and the README text next to them.
- Test on both a layout page and the layout history page, and with more than one keyboard model if you can.

## Pull requests

- Keep each pull request focused on one change.
- Describe what changed and why, and how you tested it.
- Match the style of the surrounding code.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

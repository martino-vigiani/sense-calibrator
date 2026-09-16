# Contributing to Sense Calibrator

Contributions are welcome when they make the tool safer, clearer or easier to verify.

## Before you start

Use the matching issue form for a bug or a controller result. Search the open issues first so the same problem is not reported twice.

Never include a controller serial number, USB path or another device identifier. Remove those details from screenshots and console output too.

## Run the project

There is no build step and there are no runtime dependencies.

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000` in desktop Chrome or Edge. Use a standard DualSense over a USB data cable. Add `?preview=1` only when working on an experimental tool locally.

Run the automated checks before opening a pull request:

```sh
npm test
```

These checks cover the public search surface and the telemetry contract. They do not replace a test with a real controller.

## Make a focused change

Keep each pull request about one problem. Explain what changed, why it changed and how you tested it. Include before and after measurements when controller behavior is involved.

Changes that write calibration data need extra care. Test the temporary result before writing it to controller memory, and report any interruption or recovery path you tried. Do not claim hardware support that you could not test.

## Code and text

The project uses plain HTML, CSS and JavaScript. Follow the style of the surrounding file and avoid adding a dependency when the browser platform already provides what is needed.

Write for someone holding a controller, not for the implementation. Prefer short instructions, state limits directly and keep protocol details in the technical documentation.

By submitting a contribution, you agree that it can be released under the [MIT License](LICENSE).

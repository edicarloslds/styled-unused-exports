# styled-unused-exports

`styled-unused-exports` is a Visual Studio Code extension that helps developers detect unused styled-components exports in JavaScript and TypeScript files. This tool is particularly useful for maintaining clean and efficient codebases when working with styled-components.

## Features

- Automatically scans JavaScript/TypeScript files for unused styled-components exports.
- Provides warnings in the editor for unused exports.
- Supports `.js`, `.jsx`, `.ts`, and `.tsx` files.
- Runs checks on file open and save events.
- Command to manually check the current file for unused exports.

## Requirements

- Visual Studio Code version `^1.60.0` or higher.
- Node.js installed in your environment.

## Extension Settings

This extension does not currently add any custom settings. It works out of the box.

## Commands

This extension contributes the following command:

- **Check Unused Styled Exports** (`styled-unused-exports.checkUnusedExports`): Manually check the current file for unused styled-components exports.

## Known Issues

- The extension assumes styled-components are declared using the `const` keyword. Other patterns may not be detected.
- If a styled-component is dynamically imported or used in a non-standard way, it may be flagged as unused.

## Release Notes

### 0.0.1

- Initial release with support for detecting unused styled-components exports.

### 0.0.2

- Improved performance by debouncing the check triggered on file save, reducing potential VS Code freezes.

### 0.0.3

- Improved performance with debouncing on file save, and enhance component detection logic

---

## For more information

- [Visual Studio Code Extension API](https://code.visualstudio.com/api)
- [styled-components Documentation](https://styled-components.com/docs)

**Enjoy using `styled-unused-exports`!**
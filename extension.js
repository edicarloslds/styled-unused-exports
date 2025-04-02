const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

// Diagnostic collection to display errors
let diagnosticCollection;

/**
 * Activates the extension
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // Create diagnostic collection
  diagnosticCollection = vscode.languages.createDiagnosticCollection(
    "styled-unused-exports"
  );
  context.subscriptions.push(diagnosticCollection);

  // Register command to check unused exports
  let disposable = vscode.commands.registerCommand(
    "styled-unused-exports.checkUnusedExports",
    checkCurrentFile
  );
  context.subscriptions.push(disposable);

  // Automatically check when opening/saving files
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(checkDocument)
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(checkDocument)
  );

  // Check the current document
  if (vscode.window.activeTextEditor) {
    checkDocument(vscode.window.activeTextEditor.document);
  }
}

/**
 * Checks the current file
 */
function checkCurrentFile() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    checkDocument(editor.document);
  }
}

/**
 * Checks a document for unused exports
 * @param {vscode.TextDocument} document
 */
function checkDocument(document) {
  // Only check JavaScript/TypeScript files
  if (
    !["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(
      document.languageId
    )
  ) {
    return;
  }

  const text = document.getText();
  const diagnostics = [];

  // Find all styled-components declarations
  const styledComponentRegex = /const\s+(\w+)\s*=\s*styled\.[a-zA-Z0-9]+`/g;
  const styledComponents = [];
  let match;

  while ((match = styledComponentRegex.exec(text)) !== null) {
    styledComponents.push({
      name: match[1],
      position: document.positionAt(match.index),
    });
  }

  // Find export declarations
  const exportRegex = /export\s*{([^}]+)}/g;
  let exportMatch;

  while ((exportMatch = exportRegex.exec(text)) !== null) {
    const exportContent = exportMatch[1];
    const exportedItems = exportContent
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    // For each exported item, check if it is used in the project
    for (const exportedItem of exportedItems) {
      // Find the item's position in the export
      const itemIndex = text.indexOf(exportedItem, exportMatch.index);
      if (itemIndex !== -1) {
        const position = document.positionAt(itemIndex);

        // Check if the component is used in other files
        checkComponentUsage(document, exportedItem).then((isUsed) => {
          if (!isUsed) {
            // Create diagnostic for unused component
            const range = new vscode.Range(
              position,
              position.translate(0, exportedItem.length)
            );
            const diagnostic = new vscode.Diagnostic(
              range,
              `The styled component '${exportedItem}' is exported but not used anywhere.`,
              vscode.DiagnosticSeverity.Warning
            );
            diagnostics.push(diagnostic);
            diagnosticCollection.set(document.uri, diagnostics);
          }
        });
      }
    }
  }
}

/**
 * Checks if a component is used in other files in the project
 * @param {vscode.TextDocument} document
 * @param {string} componentName
 * @returns {Promise<boolean>}
 */
async function checkComponentUsage(document, componentName) {
  // Get the current file's directory
  const currentFilePath = document.fileName;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

  if (!workspaceFolder) {
    return true; // If the workspace cannot be determined, assume it is used
  }

  // Search for all JS/TS/JSX/TSX files in the workspace
  const filePattern = new vscode.RelativePattern(
    workspaceFolder,
    "**/*.{js,jsx,ts,tsx}"
  );
  const files = await vscode.workspace.findFiles(filePattern);

  // Filter out the current file
  const otherFiles = files.filter(
    (file) => file.fsPath !== currentFilePath
  );

  // Check each file for imports of the component
  for (const file of otherFiles) {
    try {
      const content = fs.readFileSync(file.fsPath, "utf8");
      
      // Check for imports from the current file
      const importRegex = new RegExp(
        `import[^;]*{[^}]*${componentName}[^}]*}[^;]*from[^;]*['"]${path.basename(
          currentFilePath,
          path.extname(currentFilePath)
        )}['"]`,
        "g"
      );
      
      // Check for direct usage of the component
      const usageRegex = new RegExp(`<${componentName}[\\s/>]`, "g");
      
      if (importRegex.test(content) && usageRegex.test(content)) {
        return true; // Component is imported and used
      }
    } catch (error) {
      console.error(`Error reading file ${file.fsPath}:`, error);
    }
  }

  return false; // Component is not used anywhere
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
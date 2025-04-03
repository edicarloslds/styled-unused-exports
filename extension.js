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
  console.log("Extension 'styled-unused-exports' activated!");

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

  // Check when documents are opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(checkDocument)
  );
  
  // Check when documents are saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(checkDocument)
  );
  
  // Check when document content changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      clearTimeout(event.document._checkTimeout);
      event.document._checkTimeout = setTimeout(() => {
        checkDocument(event.document);
      }, 500);
    })
  );

  // Check current document
  if (vscode.window.activeTextEditor) {
    checkDocument(vscode.window.activeTextEditor.document);
  }
  
  // Check when changing editor focus
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        checkDocument(editor.document);
      }
    })
  );
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
 * Checks a document for unused styled-component exports
 * @param {vscode.TextDocument} document
 */
async function checkDocument(document) {
  // Only check JavaScript/TypeScript files
  if (!isJsOrTsFile(document)) {
    return;
  }
  
  // Clear existing diagnostics
  diagnosticCollection.delete(document.uri);
  
  const text = document.getText();
  
  // Check if this is a styled-components file with exports
  if (isStyledComponentFile(text)) {
    await checkStyledComponentFile(document);
  }
}

/**
 * Checks if a document is a JavaScript or TypeScript file
 * @param {vscode.TextDocument} document
 * @returns {boolean}
 */
function isJsOrTsFile(document) {
  return ["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(
    document.languageId
  );
}

/**
 * Checks if the file content appears to be a styled-components file with exports
 * @param {string} text
 * @returns {boolean}
 */
function isStyledComponentFile(text) {
  return (
    text.includes("styled.") && 
    (text.includes("export {") || text.match(/export\s+const\s+\w+\s*=\s*styled\./))
  );
}

/**
 * Checks a styled-component file for unused exports
 * @param {vscode.TextDocument} document
 */
async function checkStyledComponentFile(document) {
  const text = document.getText();
  const diagnostics = [];
  
  // Get all exported components
  const exportedComponents = getExportedComponents(text);
  
  // Find files that might import from this file
  const importingFiles = await findFilesImportingFrom(document);
  
  // Check each exported component
  for (const component of exportedComponents) {
    const isUsed = await isComponentUsed(component.name, document, importingFiles);
    
    if (!isUsed) {
      // Create diagnostic for unused component
      const diagnostic = new vscode.Diagnostic(
        component.range,
        `Styled component '${component.name}' is exported but not used anywhere.`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = "styled-unused-exports";
      diagnostics.push(diagnostic);
    }
  }
  
  // Set diagnostics if any components are unused
  if (diagnostics.length > 0) {
    diagnosticCollection.set(document.uri, diagnostics);
  }
}

/**
 * Gets all exported components from a styled-components file
 * @param {string} text
 * @returns {Array<{name: string, range: vscode.Range}>}
 */
function getExportedComponents(text) {
  const components = [];
  const document = { getText: () => text, positionAt: (index) => ({ line: 0, character: index }) };
  
  // Find named exports (export { Component1, Component2 })
  const namedExportRegex = /export\s*{([^}]+)}/g;
  let namedMatch;
  
  while ((namedMatch = namedExportRegex.exec(text)) !== null) {
    const exportContent = namedMatch[1];
    const exportedItems = exportContent
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    
    for (const item of exportedItems) {
      const itemIndex = text.indexOf(item, namedMatch.index);
      if (itemIndex !== -1) {
        const start = document.positionAt(itemIndex);
        const end = document.positionAt(itemIndex + item.length);
        components.push({
          name: item,
          range: new vscode.Range(start, end)
        });
      }
    }
  }
  
  // Find direct exports (export const Component = styled...)
  const directExportRegex = /export\s+const\s+(\w+)\s*=\s*styled\.[a-zA-Z0-9]+`/g;
  let directMatch;
  
  while ((directMatch = directExportRegex.exec(text)) !== null) {
    const name = directMatch[1];
    const start = document.positionAt(directMatch.index + "export const ".length);
    const end = document.positionAt(directMatch.index + "export const ".length + name.length);
    
    components.push({
      name,
      range: new vscode.Range(start, end)
    });
  }
  
  return components;
}

/**
 * Finds all files in the workspace that might import from the given document
 * @param {vscode.TextDocument} document
 * @returns {Promise<vscode.Uri[]>}
 */
async function findFilesImportingFrom(document) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return [];
  }
  
  // Get file name without extension for import matching
  const fileName = path.basename(document.fileName, path.extname(document.fileName));
  
  const importingFiles = [];
  
  // Find all JS/TS files in the workspace
  for (const folder of workspaceFolders) {
    const filePattern = new vscode.RelativePattern(
      folder,
      "**/*.{js,jsx,ts,tsx}"
    );
    const files = await vscode.workspace.findFiles(filePattern);
    
    // Filter out the current file
    const otherFiles = files.filter(file => file.fsPath !== document.fileName);
    
    for (const file of otherFiles) {
      try {
        const content = fs.readFileSync(file.fsPath, "utf8");
        
        // Check if this file imports from our target file
        if (mightImportFromFile(content, fileName)) {
          importingFiles.push(file);
        }
      } catch (error) {
        console.error(`Error reading file ${file.fsPath}:`, error);
      }
    }
  }
  
  return importingFiles;
}

/**
 * Checks if content might import from a file with the given name
 * @param {string} content
 * @param {string} fileName
 * @returns {boolean}
 */
function mightImportFromFile(content, fileName) {
  // Look for import statements that might reference our file
  const importRegex = new RegExp(`import\\s+(?:\\*\\s+as\\s+\\w+|{[^}]*}|\\w+)\\s+from\\s+['"](?:.*\\/)?${fileName}(?:\\.\\w+)?['"]`, "g");
  return importRegex.test(content);
}

/**
 * Checks if a component is used in any of the importing files
 * @param {string} componentName
 * @param {vscode.TextDocument} sourceDocument
 * @param {vscode.Uri[]} importingFiles
 * @returns {Promise<boolean>}
 */
async function isComponentUsed(componentName, sourceDocument, importingFiles) {
  const fileName = path.basename(sourceDocument.fileName, path.extname(sourceDocument.fileName));
  
  for (const fileUri of importingFiles) {
    try {
      const content = fs.readFileSync(fileUri.fsPath, "utf8");
      
      // Check for named imports of this component
      const namedImportRegex = new RegExp(`import\\s*{[^}]*\\b${componentName}\\b[^}]*}\\s*from\\s*['"](?:.*\\/)?${fileName}(?:\\.\\w+)?['"]`, "g");
      
      // Check for namespace imports
      const namespaceImportRegex = new RegExp(`import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s*['"](?:.*\\/)?${fileName}(?:\\.\\w+)?['"]`, "g");
      
      let namespaceAlias = null;
      let namespaceMatch;
      
      // If it's a namespace import, capture the alias
      while ((namespaceMatch = namespaceImportRegex.exec(content)) !== null) {
        namespaceAlias = namespaceMatch[1];
        break;
      }
      
      // If we have a direct named import of this component
      if (namedImportRegex.test(content)) {
        // Check for direct usage of the component
        const directUsageRegex = new RegExp(`<${componentName}[\\s/>]|${componentName}\\(|${componentName}{`, "g");
        if (directUsageRegex.test(content)) {
          return true;
        }
      }
      
      // If we have a namespace import
      if (namespaceAlias) {
        // Check for namespace usage of the component
        const namespaceUsageRegex = new RegExp(`<${namespaceAlias}\\.${componentName}[\\s/>]|${namespaceAlias}\\.${componentName}\\(|${namespaceAlias}\\.${componentName}{`, "g");
        if (namespaceUsageRegex.test(content)) {
          return true;
        }
      }
    } catch (error) {
      console.error(`Error checking component usage in ${fileUri.fsPath}:`, error);
    }
  }
  
  return false;
}

/**
 * Cleans up resources when the extension is deactivated
 */
function deactivate() {
  // Clean up resources
}

module.exports = {
  activate,
  deactivate,
};

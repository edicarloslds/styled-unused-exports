const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

// Diagnostic collection to display errors
let diagnosticCollection;

// Caches
const fileContentCache = new Map(); // Cache para conteúdo de arquivos e mtime
const importingFilesCache = new Map(); // Cache para lista de arquivos que importam de um arquivo de estilo
const componentUsageCache = new Map(); // Cache para componentes usados por arquivo importador

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
    () => forceCheckCurrentFile(true) // Force check with cache invalidation
  );
  context.subscriptions.push(disposable);

  // Check when documents are opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(scheduleCheck)
  );
  
  // Check when documents are saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      // Invalidate caches related to this file and schedule check
      invalidateCachesForFile(document.uri);
      scheduleCheck(document);
    })
  );
  
  // Check when document content changes (debounced)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      // Invalidate content cache immediately
      fileContentCache.delete(event.document.uri.toString());
      // Schedule check with debounce
      scheduleCheck(event.document, 500); // Debounce for 500ms
    })
  );

  // Check when changing editor focus
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        scheduleCheck(editor.document);
      }
    })
  );
  
  // Initial check for all open documents
  vscode.workspace.textDocuments.forEach(doc => scheduleCheck(doc));
}

/**
 * Invalidates relevant caches when a file changes.
 * @param {vscode.Uri} fileUri
 */
function invalidateCachesForFile(fileUri) {
  const fileKey = fileUri.toString();
  fileContentCache.delete(fileKey);
  importingFilesCache.delete(fileKey); // Invalidate who imports *from* this file
  componentUsageCache.delete(fileKey); // Invalidate usage *within* this file
  
  // TODO: More sophisticated invalidation might be needed if this file
  //       stops importing from another, affecting the other file's check.
  //       For now, saving the other file will trigger its re-check.
}

/**
 * Schedules a check for the document, optionally debounced.
 * @param {vscode.TextDocument} document
 * @param {number} [debounceMs] Optional debounce time in milliseconds.
 */
function scheduleCheck(document, debounceMs) {
  if (!isJsOrTsFile(document)) {
    return;
  }
  
  clearTimeout(document._checkTimeout);
  
  if (debounceMs > 0) {
    document._checkTimeout = setTimeout(() => {
      checkDocument(document);
    }, debounceMs);
  } else {
    // Check immediately (e.g., on open, save, focus change)
    checkDocument(document);
  }
}

/**
 * Forces a check on the current file, optionally clearing caches first.
 * @param {boolean} [invalidateCache=false]
 */
function forceCheckCurrentFile(invalidateCache = false) {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    if (invalidateCache) {
      invalidateCachesForFile(editor.document.uri);
      // Consider invalidating caches more broadly if needed
    }
    checkDocument(editor.document);
  }
}

/**
 * Reads file content, using cache if possible.
 * @param {vscode.Uri} fileUri
 * @returns {string | null} File content or null if error.
 */
function readFileWithCache(fileUri) {
  const fileKey = fileUri.toString();
  const filePath = fileUri.fsPath;

  try {
    const stats = fs.statSync(filePath);
    const mtime = stats.mtimeMs;

    if (fileContentCache.has(fileKey)) {
      const cached = fileContentCache.get(fileKey);
      if (cached.mtime === mtime) {
        return cached.content; // Return cached content if mtime matches
      }
    }

    // Read file, update cache, and return content
    const content = fs.readFileSync(filePath, "utf8");
    fileContentCache.set(fileKey, { content, mtime });
    return content;
  } catch (error) {
    // File might have been deleted or inaccessible
    fileContentCache.delete(fileKey); // Remove potentially stale cache entry
    console.error(`Error reading file ${filePath}:`, error.code);
    return null;
  }
}

/**
 * Checks a document for unused styled-component exports.
 * @param {vscode.TextDocument} document
 */
async function checkDocument(document) {
  // Only check JavaScript/TypeScript files
  if (!isJsOrTsFile(document)) {
    return;
  }
  
  // Clear existing diagnostics for this file first
  diagnosticCollection.delete(document.uri);
  
  const text = document.getText(); // Use live content from editor
  
  // Check if this is a styled-components file with exports
  if (isStyledComponentFile(text)) {
    await checkStyledComponentFile(document, text);
  }
  
  // TODO: Also check files that *import* from this file if its exports changed?
  // This requires tracking dependencies more actively.
}

/**
 * Checks if a document is a JavaScript or TypeScript file.
 * @param {vscode.TextDocument} document
 * @returns {boolean}
 */
function isJsOrTsFile(document) {
  return ["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(
    document.languageId
  );
}

/**
 * Checks if the file content appears to be a styled-components file with exports.
 * @param {string} text
 * @returns {boolean}
 */
function isStyledComponentFile(text) {
  // Faster check: Look for common patterns without complex regex first
  if (!text.includes("styled.") || (!text.includes("export {") && !text.includes("export const"))) {
    return false;
  }
  // More specific check if needed
  return text.includes("styled.") && 
         (text.includes("export {") || /export\s+const\s+\w+\s*=\s*styled\./.test(text));
}

/**
 * Checks a styled-component file for unused exports.
 * @param {vscode.TextDocument} document The document object for position mapping.
 * @param {string} text The current text content of the document.
 */
async function checkStyledComponentFile(document, text) {
  const diagnostics = [];
  
  // Get all exported components (using current text)
  const exportedComponents = getExportedComponents(text, document);
  
  // Find files that might import from this file (use cache)
  const importingFiles = await findFilesImportingFromCached(document);
  
  // Pre-calculate usage for all importing files
  const usageByFile = new Map(); // Map<string, Set<string>> fileUri -> Set<usedComponentNames>
  for (const fileUri of importingFiles) {
    const usedComponents = getUsedComponentsFromFileCached(fileUri, document);
    if (usedComponents) {
      usageByFile.set(fileUri.toString(), usedComponents);
    }
  }

  // Check each exported component
  for (const component of exportedComponents) {
    let isUsed = false;
    // Check if *any* importing file uses this component
    for (const usedSet of usageByFile.values()) {
      if (usedSet.has(component.name)) {
        isUsed = true;
        break; // Found usage, no need to check other files
      }
    }
    
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
  
  // Set diagnostics (even if empty, to clear previous ones)
  diagnosticCollection.set(document.uri, diagnostics);
}

/**
 * Gets all exported components from text content.
 * @param {string} text
 * @param {vscode.TextDocument} document For position mapping.
 * @returns {Array<{name: string, range: vscode.Range}>}
 */
function getExportedComponents(text, document) {
  // This function doesn't change much, but ensure it uses the passed document
  // for positionAt calls if line/character info is needed accurately.
  // For simplicity, assuming positionAt works with index on the provided text.
  
  const components = [];
  const positionAt = (index) => document.positionAt(index); // Use document's method

  // Find named exports (export { Component1, Component2 })
  const namedExportRegex = /export\s*{([^}]+)}/g;
  let namedMatch;
  
  while ((namedMatch = namedExportRegex.exec(text)) !== null) {
    const exportContent = namedMatch[1];
    // Handle potential comments inside export block
    const cleanedContent = exportContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    const exportedItems = cleanedContent
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    
    for (const item of exportedItems) {
      // More robust index finding
      const itemRegex = new RegExp(`\\b${item}\\b`);
      const itemIndex = text.slice(namedMatch.index, namedMatch.index + namedMatch[0].length).search(itemRegex);
      
      if (itemIndex !== -1) {
        const actualIndex = namedMatch.index + itemIndex;
        const start = positionAt(actualIndex);
        const end = positionAt(actualIndex + item.length);
        components.push({
          name: item,
          range: new vscode.Range(start, end)
        });
      }
    }
  }
  
  // Find direct exports (export const Component = styled...)
  const directExportRegex = /export\s+const\s+(\w+)\s*=\s*styled\.[a-zA-Z0-9]+(?:<[^>]+>)?`/g; // Handle generics
  let directMatch;
  
  while ((directMatch = directExportRegex.exec(text)) !== null) {
    const name = directMatch[1];
    const nameStartIndex = directMatch[0].indexOf(name, "export const ".length);
    const start = positionAt(directMatch.index + nameStartIndex);
    const end = positionAt(directMatch.index + nameStartIndex + name.length);
    
    components.push({
      name,
      range: new vscode.Range(start, end)
    });
  }
  
  return components;
}

/**
 * Finds all files in the workspace that might import from the given document, using cache.
 * @param {vscode.TextDocument} document
 * @returns {Promise<vscode.Uri[]>}
 */
async function findFilesImportingFromCached(document) {
  const fileKey = document.uri.toString();
  if (importingFilesCache.has(fileKey)) {
    return importingFilesCache.get(fileKey);
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return [];
  }
  
  const fileName = path.basename(document.fileName, path.extname(document.fileName));
  const importingFiles = [];
  
  // Find all JS/TS files in the workspace
  // Note: This workspace scan is still potentially slow on very large projects.
  // A FileSystemWatcher approach would be more advanced.
  for (const folder of workspaceFolders) {
    const filePattern = new vscode.RelativePattern(
      folder,
      "**/*.{js,jsx,ts,tsx}"
    );
    // Exclude node_modules for performance
    const excludePattern = "**/node_modules/**"; 
    const files = await vscode.workspace.findFiles(filePattern, excludePattern);
    
    const otherFiles = files.filter(file => file.fsPath !== document.fileName);
    
    for (const file of otherFiles) {
      const content = readFileWithCache(file); // Use cached read
      if (content && mightImportFromFile(content, fileName)) {
        importingFiles.push(file);
      }
    }
  }
  
  importingFilesCache.set(fileKey, importingFiles); // Store in cache
  return importingFiles;
}

/**
 * Checks if content might import from a file with the given name.
 * @param {string} content
 * @param {string} fileName
 * @returns {boolean}
 */
function mightImportFromFile(content, fileName) {
  // Optimized regex: Avoids unnecessary checks if filename isn't present
  if (!content.includes(fileName)) {
    return false;
  }
  const importRegex = new RegExp(`import\\s+(?:\\*\\s+as\\s+\\w+|{[^}]*}|\\w+)\\s+from\\s+['"](?:.*\\/)?${fileName}(?:\\.\\w+)?['"]`);
  return importRegex.test(content);
}

/**
 * Gets the set of used styled components from a specific style file within an importing file, using cache.
 * @param {vscode.Uri} importingFileUri
 * @param {vscode.TextDocument} styleDocument
 * @returns {Set<string> | null} Set of used component names, or null if error.
 */
function getUsedComponentsFromFileCached(importingFileUri, styleDocument) {
  const importingFileKey = importingFileUri.toString();
  const styleFileName = path.basename(styleDocument.fileName, path.extname(styleDocument.fileName));

  // Check cache: componentUsageCache stores Map<importingFileKey, Map<styleFileName, Set<usedComponents>>>
  if (componentUsageCache.has(importingFileKey)) {
    const styleUsageMap = componentUsageCache.get(importingFileKey);
    if (styleUsageMap.has(styleFileName)) {
      return styleUsageMap.get(styleFileName);
    }
  }

  const content = readFileWithCache(importingFileUri); // Use cached read
  if (!content) {
    return null; // Error reading file
  }

  const usedComponents = new Set();
  
  // Find namespace alias if used for this style file
  let namespaceAlias = null;
  const namespaceImportRegex = new RegExp(`import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s*['"](?:.*\\/)?${styleFileName}(?:\\.\\w+)?['"]`);
  const namespaceMatch = content.match(namespaceImportRegex);
  if (namespaceMatch) {
    namespaceAlias = namespaceMatch[1];
  }

  // Find all potential component usages (adjust regex as needed for accuracy)
  // Regex to find <Component ...>, Component(...), Component{...}, <S.Component ...>, S.Component(...) etc.
  const usageRegex = namespaceAlias 
    ? new RegExp(`(?:<|\\b)${namespaceAlias}\\.(\\w+)|(?:<|\\b)(\\w+)`, 'g') // Look for S.Comp and Comp
    : new RegExp(`(?:<|\\b)(\\w+)`, 'g'); // Look for Comp only if no namespace

  let usageMatch;
  while ((usageMatch = usageRegex.exec(content)) !== null) {
    const potentialComp = usageMatch[1] || usageMatch[2]; // Component name from either group
    
    // Basic check: Is it capitalized? (Likely a component)
    if (potentialComp && potentialComp[0] === potentialComp[0].toUpperCase()) {
      // More specific check: Does this component seem to be imported from our style file?
      // This requires checking the import statements again, which we try to optimize.
      // For now, we assume any capitalized usage *could* be from the style file if imported.
      usedComponents.add(potentialComp);
    }
  }
  
  // Refine based on actual imports (more accurate but slower)
  // This part is complex: we need to know *which* specific components were imported by name.
  // For performance, the current approach assumes any capitalized usage in a file that imports
  // the style file *might* be a usage. This can lead to false negatives (warning disappears
  // when it shouldn't) if a component with the same name is imported from elsewhere.

  // Store result in cache
  if (!componentUsageCache.has(importingFileKey)) {
    componentUsageCache.set(importingFileKey, new Map());
  }
  componentUsageCache.get(importingFileKey).set(styleFileName, usedComponents);

  return usedComponents;
}


/**
 * Cleans up resources when the extension is deactivated.
 */
function deactivate() {
  // Clear caches on deactivation
  fileContentCache.clear();
  importingFilesCache.clear();
  componentUsageCache.clear();
  // Dispose diagnostic collection? VS Code might handle this.
  if (diagnosticCollection) {
    diagnosticCollection.dispose();
  }
}

module.exports = {
  activate,
  deactivate,
};

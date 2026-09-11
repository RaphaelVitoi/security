/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface SecurityDependencies {
  fs: typeof fs;
  path: typeof path;
}

const DEFAULT_DEPS: SecurityDependencies = { fs, path };

function matchSnippetAt(
  lines: string[],
  potentialStartLine: number,
  snippetLines: string[]
): boolean {
  for (let j = 1; j < snippetLines.length; j++) {
    const fileLineIndex = potentialStartLine - 1 + j;
    if (
      fileLineIndex >= lines.length ||
      lines[fileLineIndex].trim() !== snippetLines[j].trim()
    ) {
      return false;
    }
  }
  return true;
}

export async function findLineNumbers(
  {
    filePath,
    snippet,
  }: {
    filePath: string;
    snippet: string;
  },
  dependencies: SecurityDependencies = DEFAULT_DEPS
): Promise<CallToolResult> {
  try {
    const CWD = process.cwd();
    const safeFilePath = await dependencies.fs.realpath(
      dependencies.path.resolve(CWD, filePath)
    );
    if (!safeFilePath.startsWith(CWD + dependencies.path.sep)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'File path is outside of the current working directory.',
            }),
          },
        ],
      };
    }
    const content = await dependencies.fs.readFile(safeFilePath, 'utf-8');
    const lines = content.split('\n');
    const snippetLines = snippet.trim().split('\n');
    const snippetLineCount = snippetLines.length;
    let startLine = -1;
    let endLine = -1;

    if (!snippet.trim()) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'Snippet is empty.' }),
          },
        ],
      };
    }

    const lineToNumbers = new Map<string, number[]>();
    for (let i = 0; i < lines.length; i++) {
      const trimmedLine = lines[i].trim();
      if (!lineToNumbers.has(trimmedLine)) {
        lineToNumbers.set(trimmedLine, []);
      }
      lineToNumbers.get(trimmedLine)!.push(i + 1);
    }

    const firstSnippetLine = snippetLines[0].trim();
    const candidateLines = lineToNumbers.get(firstSnippetLine) ?? [];
    for (const potentialStartLine of candidateLines) {
      if (matchSnippetAt(lines, potentialStartLine, snippetLines)) {
        startLine = potentialStartLine;
        endLine = potentialStartLine + snippetLineCount - 1;
        break;
      }
    }

    if (startLine === -1 || endLine === -1) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'Snippet was not found.' }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ startLine, endLine }),
        },
      ],
    };
  } catch (error) {
    let errorMessage = 'An unknown error occurred.';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
    };
  }
}

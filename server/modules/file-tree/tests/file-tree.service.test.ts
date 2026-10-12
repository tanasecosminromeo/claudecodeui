import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      homePath: os.homedir(),
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('readTextFile follows a path out of the project to the file it names', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'next to the project';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.readTextFile('project-1', '../notes.txt');
  assert.deepEqual(result, { content: 'next to the project', path: path.resolve(projectRoot, '../notes.txt') });
  assert.deepEqual(readPaths, [path.resolve(projectRoot, '../notes.txt')]);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

/**
 * Builds the service against the real filesystem and the real workspace policy:
 * reads outside the project are decided by what the OS lets this process read,
 * so only real files and real permission bits exercise it.
 */
function createRealFileSystemService(projectRoot: string, homePath = os.homedir()): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath, mode) => fsPromises.access(candidatePath, mode),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: projectRoot,
      homePath,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });
}

// Root reads everything, so permission tests say nothing when run as root.
const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const isAppError = (code: string, statusCode: number) => (error: unknown) => error instanceof AppError
  && error.code === code
  && error.statusCode === statusCode;

test('a folder outside the project can be browsed and read, but never written to', async () => {
  // Beside this file rather than under the temp directory: no folder is special any more.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    await fsPromises.mkdir(path.join(outsideDirectory, 'tasks'));
    const outputPath = path.join(outsideDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(outsideDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const listed = await service.listProjectFiles('project-1', { respectGitignore: true, rootPath: outsideDirectory });
    assert.deepEqual(listed.map((entry) => entry.name), ['tasks']);
    assert.deepEqual(listed[0].children?.map((entry) => entry.path), [outputPath]);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');
    assert.equal(opened.path, outputPath);

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      isAppError('PATH_OUTSIDE_PROJECT', 403),
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(os.tmpdir(), 'file-tree-new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(outsideDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      isAppError('PATH_OUTSIDE_PROJECT', 403),
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      isAppError('PATH_OUTSIDE_PROJECT', 403),
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(outsideDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      isAppError('PATH_OUTSIDE_PROJECT', 403),
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      isAppError('PATH_OUTSIDE_PROJECT', 403),
    );
    assert.deepEqual(await fsPromises.readdir(path.join(outsideDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('a relative path out of the project is read from where it points, and never written there', async () => {
  const base = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-play-'));
  const projectRoot = path.join(base, 'repo');
  const playRoot = path.join(base, '_play');
  await Promise.all([projectRoot, playRoot].map((directory) => fsPromises.mkdir(directory)));
  const report = '<!doctype html><title>report</title>';
  await fsPromises.writeFile(path.join(playRoot, 'report.html'), report, 'utf8');

  try {
    const service = createRealFileSystemService(projectRoot);

    // The shape a transcript quotes when an agent writes its report next to the repository.
    const opened = await service.readTextFile('project-1', '../_play/report.html');
    assert.equal(opened.content, report);
    assert.equal(opened.path, path.join(playRoot, 'report.html'));
    (await service.openFile('project-1', '../_play/report.html')).stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', '../_play/report.html', 'overwritten'),
      isAppError('PATH_OUTSIDE_PROJECT', 403),
    );
    assert.equal(await fsPromises.readFile(path.join(playRoot, 'report.html'), 'utf8'), report);
  } finally {
    await fsPromises.rm(base, { recursive: true, force: true });
  }
});

test('a file the server may not read is a permission error, a missing one is not found', { skip: runsAsRoot }, async () => {
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  const lockedPath = path.join(outsideDirectory, 'locked.txt');
  const lockedDirectory = path.join(outsideDirectory, 'locked-dir');

  try {
    await fsPromises.writeFile(lockedPath, 'secret', 'utf8');
    await fsPromises.chmod(lockedPath, 0o000);
    await fsPromises.mkdir(lockedDirectory);
    await fsPromises.chmod(lockedDirectory, 0o000);
    const service = createRealFileSystemService(projectRoot);

    await assert.rejects(service.readTextFile('project-1', lockedPath), isAppError('PERMISSION_DENIED', 403));
    await assert.rejects(service.openFile('project-1', lockedPath), isAppError('PERMISSION_DENIED', 403));
    await assert.rejects(
      service.listProjectFiles('project-1', { respectGitignore: true, rootPath: lockedDirectory }),
      isAppError('PERMISSION_DENIED', 403),
    );
    await assert.rejects(service.browseWorkspace(lockedDirectory), isAppError('PERMISSION_DENIED', 403));

    const missingPath = path.join(outsideDirectory, 'missing.txt');
    await assert.rejects(service.readTextFile('project-1', missingPath), isAppError('FILE_NOT_FOUND', 404));
    await assert.rejects(service.openFile('project-1', missingPath), isAppError('FILE_NOT_FOUND', 404));
  } finally {
    await fsPromises.chmod(lockedDirectory, 0o700).catch(() => undefined);
    await fsPromises.chmod(lockedPath, 0o600).catch(() => undefined);
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('a `~/` path is read from the home directory, under the same read policy', async () => {
  const homePath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-home-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    await fsPromises.mkdir(path.join(homePath, 'reports'));
    await fsPromises.writeFile(path.join(homePath, 'reports', 'report.html'), '<h1>report</h1>', 'utf8');

    const service = createRealFileSystemService(projectRoot, homePath);
    const opened = await service.readTextFile('project-1', '~/reports/report.html');
    assert.equal(opened.content, '<h1>report</h1>');
    assert.equal(opened.path, path.join(homePath, 'reports', 'report.html'));

    const listed = await service.listProjectFiles('project-1', { respectGitignore: true, rootPath: '~/reports' });
    assert.deepEqual(listed.map((entry) => entry.path), [path.join(homePath, 'reports', 'report.html')]);

    // Writes never expand it: `~` stays a literal name inside the project.
    await assert.rejects(
      service.saveTextFile('project-1', '~/reports/report.html', 'overwritten'),
      (error: unknown) => (error as AppError).statusCode === 404,
    );
    assert.equal(await fsPromises.readFile(path.join(homePath, 'reports', 'report.html'), 'utf8'), '<h1>report</h1>');
  } finally {
    await fsPromises.rm(homePath, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('resolveFileReference returns the first readable file, else a folder, else one it may not read', { skip: runsAsRoot }, async () => {
  const reportsDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-reports-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  const lockedPath = path.join(reportsDirectory, 'locked.html');

  try {
    await fsPromises.mkdir(path.join(reportsDirectory, 'nested'));
    await fsPromises.writeFile(path.join(reportsDirectory, 'report.html'), 'report', 'utf8');
    await fsPromises.writeFile(lockedPath, 'locked', 'utf8');
    await fsPromises.chmod(lockedPath, 0o000);
    const service = createRealFileSystemService(projectRoot);

    // A missing guess, a directory and an unreadable file are all passed over
    // for the readable one, whatever their order.
    assert.deepEqual(
      await service.resolveFileReference('project-1', [
        'report.html',
        lockedPath,
        path.join(reportsDirectory, 'nested'),
        path.join(reportsDirectory, 'report.html'),
      ]),
      { path: path.join(reportsDirectory, 'report.html'), directoryPath: null, deniedPath: null },
    );

    // No readable file: a folder is the next best thing to open.
    assert.deepEqual(
      await service.resolveFileReference('project-1', ['report.html', lockedPath, path.join(reportsDirectory, 'nested')]),
      { path: null, directoryPath: path.join(reportsDirectory, 'nested'), deniedPath: lockedPath },
    );

    // Only an unreadable file: named, so the client can say why it will not open.
    assert.deepEqual(
      await service.resolveFileReference('project-1', [
        'report.html',
        path.join(reportsDirectory, 'missing.html'),
        lockedPath,
      ]),
      { path: null, directoryPath: null, deniedPath: lockedPath },
    );

    assert.deepEqual(
      await service.resolveFileReference('project-1', ['report.html', path.join(reportsDirectory, 'missing.html')]),
      { path: null, directoryPath: null, deniedPath: null },
    );
  } finally {
    await fsPromises.chmod(lockedPath, 0o600).catch(() => undefined);
    await fsPromises.rm(reportsDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('env, key and credential files are listed as protected and their contents never read', async () => {
  const homePath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-home-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  const FAKE = 'FAKE_TEST_VALUE_not_a_real_key';

  try {
    await fsPromises.writeFile(path.join(projectRoot, '.env'), `API_TOKEN=${FAKE}\n`, 'utf8');
    await fsPromises.writeFile(path.join(projectRoot, 'release.jks'), FAKE, 'utf8');
    await fsPromises.writeFile(path.join(projectRoot, 'load-env.ts'), 'export {};\n', 'utf8');
    await fsPromises.mkdir(path.join(homePath, '.ssh'));
    await fsPromises.writeFile(path.join(homePath, '.ssh', 'id_ed25519'), FAKE, 'utf8');
    await fsPromises.symlink(path.join(homePath, '.ssh', 'id_ed25519'), path.join(projectRoot, 'notes.txt'));

    const service = createRealFileSystemService(projectRoot, homePath);
    const listed = await service.listProjectFiles('project-1', { respectGitignore: false });
    const marks = Object.fromEntries(listed.map((entry) => [entry.name, entry.protected === true]));
    assert.deepEqual(marks, { '.env': true, 'load-env.ts': false, 'notes.txt': true, 'release.jks': true });

    const refused = (error: unknown) => (error as AppError).statusCode === 403
      && (error as AppError & { code?: string }).code === 'PROTECTED_FILE'
      && !String((error as Error).message).includes(FAKE);
    for (const target of ['.env', 'release.jks', 'notes.txt', '~/.ssh/id_ed25519', path.join(homePath, '.ssh', 'id_ed25519')]) {
      await assert.rejects(service.readTextFile('project-1', target), refused, `read ${target}`);
      await assert.rejects(service.openFile('project-1', target), refused, `open ${target}`);
    }
    // Never shown, so never overwritten through the editor either.
    await assert.rejects(service.saveTextFile('project-1', '.env', 'API_TOKEN=changed'), refused);
    assert.equal(await fsPromises.readFile(path.join(projectRoot, '.env'), 'utf8'), `API_TOKEN=${FAKE}\n`);

    const plain = await service.readTextFile('project-1', 'load-env.ts');
    assert.equal(plain.content, 'export {};\n');
  } finally {
    await fsPromises.rm(homePath, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('a readable file with a key-like value is shown masked and cannot be saved over', async () => {
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-masked-'));
  const FAKE = 'FAKE_TEST_VALUE_not_a_real_key';
  const original = `const port = 3001;\nAPI_KEY=${FAKE}\n`;
  const masked = (error: unknown) => (error as AppError).statusCode === 403
    && (error as AppError & { code?: string }).code === 'MASKED_FILE'
    && (error as Error).message === 'Contains key-like values: read-only here.';

  try {
    await fsPromises.writeFile(path.join(projectRoot, 'app.ts'), original, 'utf8');
    await fsPromises.writeFile(path.join(projectRoot, 'plain.ts'), 'export const port = 3001;\n', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const shown = await service.readTextFile('project-1', 'app.ts');
    assert.equal(shown.content, 'const port = 3001;\nAPI_KEY=••••\n');
    assert.equal(shown.masked, true);
    assert.equal(shown.content.includes(FAKE), false);
    assert.equal(await fsPromises.readFile(path.join(projectRoot, 'app.ts'), 'utf8'), original, 'reading changes nothing');

    await assert.rejects(service.saveTextFile('project-1', 'app.ts', shown.content), masked);
    assert.equal(await fsPromises.readFile(path.join(projectRoot, 'app.ts'), 'utf8'), original, 'the real value is kept');

    const plain = await service.readTextFile('project-1', 'plain.ts');
    assert.equal(plain.masked, undefined);
    await service.saveTextFile('project-1', 'plain.ts', 'export const port = 3002;\n');
    assert.equal(await fsPromises.readFile(path.join(projectRoot, 'plain.ts'), 'utf8'), 'export const port = 3002;\n');

    // A new file has no value to lose, so it can be created.
    await service.saveTextFile('project-1', 'new.ts', 'export const x = 1;\n');
    assert.equal(await fsPromises.readFile(path.join(projectRoot, 'new.ts'), 'utf8'), 'export const x = 1;\n');
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('a text file opened raw is masked like the editor', async () => {
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  const FAKE = ['FAKE', 'rawvalue', '9911'].join('');
  try {
    await fsPromises.writeFile(path.join(projectRoot, 'report.html'), `<p>DB_PASSWORD=${FAKE}</p>\n`, 'utf8');
    await fsPromises.writeFile(path.join(projectRoot, 'plain.html'), '<p>hello</p>\n', 'utf8');
    const service = createRealFileSystemService(projectRoot);
    const read = async (name: string) => {
      const opened = await service.openFile('project-1', name);
      let text = '';
      for await (const chunk of opened.stream) text += chunk.toString();
      return text;
    };
    const report = await read('report.html');
    assert.equal(report.includes(FAKE), false);
    assert.equal(report.includes('DB_PASSWORD=••••'), true);
    assert.equal(await read('plain.html'), '<p>hello</p>\n');
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

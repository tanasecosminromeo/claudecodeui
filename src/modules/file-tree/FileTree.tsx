import { useCallback, useState, useEffect, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, X, Loader2, Folder, Lock, Upload } from 'lucide-react';

import { cn } from '@/shared/utils';
import { ICON_SIZE_CLASS, getFileIconData } from '@/modules/file-tree/utils/fileIcons';
import { useExpandedDirectories } from '@/modules/file-tree/hooks/useExpandedDirectories';
import { useFileTreeData } from '@/modules/file-tree/hooks/useFileTreeData';
import { useFileTreeOperations } from '@/modules/file-tree/hooks/useFileTreeOperations';
import { useFileTreeSearch } from '@/modules/file-tree/hooks/useFileTreeSearch';
import { useFileTreeViewMode } from '@/modules/file-tree/hooks/useFileTreeViewMode';
import { useFileTreeUpload } from '@/modules/file-tree/hooks/useFileTreeUpload';
import type { DirectoryRevealRequest, FileTreeImageSelection, FileTreeNode,Project } from '@/shared/types';
import { formatFileSize, formatRelativeTime, isImageFile } from '@/modules/file-tree/utils/fileTreeUtils';
import { directoryRevealPaths, outsideProjectDirectory } from '@/modules/file-tree/utils/revealDirectory';
import { ScrollArea, Input } from '@/shared/ui';
import FileTreeBody from '@/modules/file-tree/FileTreeBody';
import FileTreeDetailedColumns from '@/modules/file-tree/FileTreeDetailedColumns';
import FileTreeHeader from '@/modules/file-tree/FileTreeHeader';
import FileTreeLoadingState from '@/modules/file-tree/FileTreeLoadingState';
import FileTreeUploadProgress from '@/modules/file-tree/FileTreeUploadProgress';
import ImageViewer from '@/modules/file-tree/ImageViewer';


type FileTreeProps = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  // Directory to reveal (from an in-chat `path/` reference): its ancestors are
  // expanded so the folder is visible without hunting through the tree. One
  // outside the project replaces the tree with that folder's, read-only.
  revealDirectory?: DirectoryRevealRequest | null;
};

/** Exported through the file-tree barrel; the project-workspace module renders it as the Files sidebar tab. */
export default function FileTree({ selectedProject, onFileOpen, revealDirectory }: FileTreeProps) {
  const { t } = useTranslation();
  const [selectedImage, setSelectedImage] = useState<FileTreeImageSelection | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Show toast notification
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const projectRoot = selectedProject?.path || selectedProject?.fullPath;
  const projectId = selectedProject?.projectId;

  // A folder outside the project a chat message pointed at, shown read-only in
  // place of the project's tree. Tied to the project it was opened from, so
  // switching projects returns to that project's own tree.
  const [outsideRoot, setOutsideRoot] = useState<{ projectId?: string; path: string } | null>(null);
  const readOnlyRoot = outsideRoot && outsideRoot.projectId === projectId ? outsideRoot.path : null;

  useEffect(() => {
    if (!revealDirectory || !projectRoot) {
      return;
    }
    const outsidePath = outsideProjectDirectory(projectRoot, revealDirectory.path);
    setOutsideRoot(outsidePath ? { projectId, path: outsidePath } : null);
  }, [revealDirectory, projectRoot, projectId]);

  const { files, filesRootPath, loading, error, refreshFiles } = useFileTreeData(selectedProject, readOnlyRoot);
  const { viewMode, changeViewMode } = useFileTreeViewMode();
  const { expandedDirs, toggleDirectory, expandDirectories, collapseAll } = useExpandedDirectories();
  const { searchQuery, setSearchQuery, filteredFiles } = useFileTreeSearch({
    files,
    expandDirectories,
  });

  // The reveal request already served, so a later tree refresh does not fold
  // the folders open again over a collapse the user has since made.
  const revealedRef = useRef<DirectoryRevealRequest | null>(null);

  // Expand every ancestor between the project root and the requested folder.
  // A request that arrives before the tree finds nothing to expand and is
  // retried when `files` lands.
  useEffect(() => {
    // Only the project's own tree holds the folder; an outside tree still on
    // screen could hold a same-named one.
    if (!revealDirectory || !projectRoot || readOnlyRoot || filesRootPath !== null
      || revealedRef.current === revealDirectory) {
      return;
    }
    const paths = directoryRevealPaths(files, projectRoot, revealDirectory.path);
    if (paths.length === 0) {
      return;
    }
    revealedRef.current = revealDirectory;
    expandDirectories(paths);
  }, [revealDirectory, projectRoot, readOnlyRoot, filesRootPath, expandDirectories, files]);

  // File operations
  const operations = useFileTreeOperations({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
  });

  // File upload (drag and drop). `treeRef` is pulled out of the returned object
  // so the remaining plain values are not treated as render-time ref reads.
  const { treeRef, ...upload } = useFileTreeUpload({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
  });
  const operationLoading = operations.operationLoading || upload.operationLoading;

  // Folder-targeted uploads (context menu / hover button) share one hidden
  // input; the target path is remembered until the user picks the files.
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const folderUploadTargetRef = useRef('');
  const { uploadFiles } = upload;

  const handleUploadToFolder = useCallback((targetPath: string) => {
    folderUploadTargetRef.current = targetPath;
    folderUploadInputRef.current?.click();
  }, []);

  const handleFolderUploadInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { files: pickedFiles } = event.target;
      if (pickedFiles && pickedFiles.length > 0) {
        uploadFiles(Array.from(pickedFiles), folderUploadTargetRef.current);
      }
      event.target.value = '';
    },
    [uploadFiles],
  );

  // Focus input when creating new item
  useEffect(() => {
    if (operations.isCreating && newItemInputRef.current) {
      newItemInputRef.current.focus();
      newItemInputRef.current.select();
    }
  }, [operations.isCreating]);

  // Focus input when renaming
  useEffect(() => {
    if (operations.renamingItem && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [operations.renamingItem]);

  const renderFileIcon = useCallback((filename: string) => {
    const { icon: Icon, color } = getFileIconData(filename);
    return <Icon className={cn(ICON_SIZE_CLASS, color)} />;
  }, []);

  // Centralized click behavior keeps file actions identical across all presentation modes.
  const handleItemClick = useCallback(
    (item: FileTreeNode) => {
      if (item.type === 'directory') {
        toggleDirectory(item.path);
        return;
      }

      if (isImageFile(item.name) && selectedProject) {
        setSelectedImage({
          name: item.name,
          path: item.path,
          projectPath: selectedProject.path,
          // Image URL uses the DB projectId so ImageViewer can hit the
          // /api/file-tree/projects/:projectId/files/content endpoint directly.
          projectId: selectedProject.projectId,
        });
        return;
      }

      onFileOpen?.(item.path);
    },
    [onFileOpen, selectedProject, toggleDirectory],
  );

  const formatRelativeTimeLabel = useCallback(
    (date?: string) => formatRelativeTime(date, t),
    [t],
  );

  if (loading) {
    return <FileTreeLoadingState />;
  }

  return (
    <div
      ref={treeRef}
      className="relative flex h-full flex-col bg-background"
      // Nothing outside the project can be written, so nothing is offered:
      // no drop target, no create, upload, rename or delete.
      onDragEnter={readOnlyRoot ? undefined : upload.handleDragEnter}
      onDragOver={readOnlyRoot ? undefined : upload.handleDragOver}
      onDragLeave={readOnlyRoot ? undefined : upload.handleDragLeave}
      onDrop={readOnlyRoot ? undefined : upload.handleDrop}
    >
      {/* Hidden input for folder-targeted uploads (context menu / hover button) */}
      <input
        ref={folderUploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderUploadInputChange}
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Drag overlay; pointer-events-none keeps folder rows reachable as drop targets */}
      {upload.isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-500/10">
          <div className="flex items-center gap-3 rounded-lg bg-background/95 px-6 py-4 shadow-lg">
            <Upload className="h-6 w-6 text-blue-500" />
            <span className="text-sm font-medium">
              {upload.dropTarget
                ? t('fileTree.dropToUploadTo', 'Drop files to upload to "{{folder}}"', {
                    folder: upload.dropTarget.split(/[\\/]/).pop(),
                  })
                : t('fileTree.dropToUpload', 'Drop files to upload')}
            </span>
          </div>
        </div>
      )}

      <FileTreeHeader
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onUploadFiles={readOnlyRoot ? undefined : upload.handleFileSelect}
        onNewFile={readOnlyRoot ? undefined : () => operations.handleStartCreate('', 'file')}
        onNewFolder={readOnlyRoot ? undefined : () => operations.handleStartCreate('', 'directory')}
        onRefresh={refreshFiles}
        onCollapseAll={collapseAll}
        loading={loading}
        operationLoading={operationLoading}
        isUploading={upload.uploadProgress?.status === 'uploading'}
        uploadProgress={upload.uploadProgress?.progress ?? null}
      />

      {readOnlyRoot && (
        <div
          data-testid="file-tree-read-only-root"
          className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs"
        >
          <Lock className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono" title={readOnlyRoot}>{readOnlyRoot}</span>
          <span className="flex-shrink-0 text-muted-foreground">{t('fileTree.readOnly', 'Read-only')}</span>
          <button
            type="button"
            className="flex-shrink-0 rounded px-1.5 py-0.5 text-primary hover:bg-accent"
            onClick={() => setOutsideRoot(null)}
          >
            {t('fileTree.backToProject', 'Back to project')}
          </button>
        </div>
      )}

      <FileTreeUploadProgress upload={upload.uploadProgress} />

      {viewMode === 'detailed' && filteredFiles.length > 0 && <FileTreeDetailedColumns />}

      <ScrollArea className="flex-1 px-2 py-1">
        {/* New item input */}
        {operations.isCreating && (
          <div
            className="mb-1 flex items-center gap-1.5 py-[3px] pr-2"
            style={{ paddingLeft: `${(operations.newItemParent.split('/').length - 1) * 16 + 4}px` }}
          >
            {operations.newItemType === 'directory' ? (
              <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-500')} />
            ) : (
              <span className="ml-[18px]">{renderFileIcon(operations.newItemName)}</span>
            )}
            <Input
              ref={newItemInputRef}
              type="text"
              value={operations.newItemName}
              onChange={(e) => operations.setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') operations.handleConfirmCreate();
                if (e.key === 'Escape') operations.handleCancelCreate();
              }}
              onBlur={() => {
                setTimeout(() => {
                  if (operations.isCreating) operations.handleConfirmCreate();
                }, 100);
              }}
              className="h-6 flex-1 text-sm"
              disabled={operationLoading}
            />
          </div>
        )}

        <FileTreeBody
          files={files}
          filteredFiles={filteredFiles}
          error={error}
          searchQuery={searchQuery}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          onItemClick={handleItemClick}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTimeLabel}
          onRename={readOnlyRoot ? undefined : operations.handleStartRename}
          onDelete={readOnlyRoot ? undefined : operations.handleStartDelete}
          onNewFile={readOnlyRoot ? undefined : (path) => operations.handleStartCreate(path, 'file')}
          onNewFolder={readOnlyRoot ? undefined : (path) => operations.handleStartCreate(path, 'directory')}
          onCopyPath={operations.handleCopyPath}
          onDownload={operations.handleDownload}
          onUpload={readOnlyRoot ? undefined : handleUploadToFolder}
          onRefresh={refreshFiles}
          dropTarget={readOnlyRoot ? null : upload.dropTarget}
          onItemDragOver={readOnlyRoot ? undefined : upload.handleItemDragOver}
          // Pass rename state and handlers for inline editing
          renamingItem={operations.renamingItem}
          renameValue={operations.renameValue}
          setRenameValue={operations.setRenameValue}
          handleConfirmRename={operations.handleConfirmRename}
          handleCancelRename={operations.handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operationLoading}
        />
      </ScrollArea>

      {selectedImage && (
        <ImageViewer
          file={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {operations.deleteConfirmation.isOpen && operations.deleteConfirmation.item && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-red-100 p-2 dark:bg-red-900/30">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {t('fileTree.delete.title', 'Delete {{type}}', {
                    type: operations.deleteConfirmation.item.type === 'directory' ? 'Folder' : 'File'
                  })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {operations.deleteConfirmation.item.name}
                </p>
              </div>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {operations.deleteConfirmation.item.type === 'directory'
                ? t('fileTree.delete.folderWarning', 'This folder and all its contents will be permanently deleted.')
                : t('fileTree.delete.fileWarning', 'This file will be permanently deleted.')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={operations.handleCancelDelete}
                disabled={operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={operations.handleConfirmDelete}
                disabled={operationLoading}
                className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {operationLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-4 right-4 z-[9999] px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-bottom-2',
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          )}
        >
          {toast.type === 'success' ? (
            <Check className="h-4 w-4" />
          ) : (
            <X className="h-4 w-4" />
          )}
          <span className="text-sm">{toast.message}</span>
        </div>
      )}
    </div>
  );
}

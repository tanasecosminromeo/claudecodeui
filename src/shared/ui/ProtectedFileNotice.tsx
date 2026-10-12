import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type ProtectedFileNoticeProps = {
  /** Path of the file, shown under the message so the user can tell which one it is. */
  path?: string;
};

/**
 * Shown by the code editor and the Source Control diff in place of the contents
 * of a file the server never sends (env, key and credential files). It is an
 * expected result, not a failure, so it is calm: no error colour.
 */
export function ProtectedFileNotice({ path }: ProtectedFileNoticeProps) {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      data-testid="protected-file-notice"
      className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground"
    >
      <Lock className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      <span>{t('protectedFile.message', 'Protected: may contain keys. Contents hidden.')}</span>
      {path && (
        <span className="max-w-full break-all font-mono text-xs" title={path}>
          {path}
        </span>
      )}
    </div>
  );
}

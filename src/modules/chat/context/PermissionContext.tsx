import { createContext, useContext } from 'react';

import type { PendingPermissionRequest, PermissionMode } from '@/shared/types';

export type PermissionContextValue = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown; permissionMode?: PermissionMode },
  ) => void;
  /** Approves a pending plan and continues in the mode the user wants, updating the selector to match. */
  approvePlan: (requestId: string) => void;
};

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

export default PermissionContext;

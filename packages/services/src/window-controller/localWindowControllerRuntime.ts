import { randomUUID } from "node:crypto";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { ServiceCollection } from "../collection.js";
import { createWindowHostControllerRuntime } from "./windowHostControllerRuntime.js";
import { IWindowControllerService } from "./windowController.js";

/**
 * 非 Desktop 宿主（HTTP / standalone server）的 Controller 装配。
 *
 * Desktop Host 有 windowRemoteConnectionRegistry，可以按 remoteSessionId 路由到远端
 * source；服务器宿主只有一份本地 services，因此所有远端 identity 的 scope 一律
 * fail-closed 返回 null，绝不落回本地 tasks-index 冒充远端 history。
 */
export function registerLocalWindowControllerService(services: ServiceCollection): {
  dispose(): void;
} {
  const taskService = services.getOptional(IZCodeTaskService);
  const agentService = services.getOptional(IZCodeAgentService);
  const runtime = createWindowHostControllerRuntime({
    createId: randomUUID,
    resolveSource: (scope) => {
      if (scope.workspaceIdentity && isRemoteWorkspaceIdentity(scope.workspaceIdentity)) {
        return null;
      }
      if (!taskService) {
        return null;
      }
      return {
        scope: {
          kind: "local" as const,
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        },
        taskService,
        ...(agentService ? { agentService } : {}),
        sourceAvailability: "online" as const,
      };
    },
    onSourceError: (scope, operation, error) => {
      console.warn(
        `[window-controller] source ${operation} failed, kind=${scope.kind}, workspace=${scope.workspaceIdentity?.trim() || scope.workspacePath}`,
        error,
      );
    },
  });
  services.register(IWindowControllerService, runtime.service);
  return { dispose: () => runtime.dispose() };
}

package com.ben47203.knimecli.server.api.project;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.eclipse.swt.widgets.Display;
import org.knime.core.node.CanceledExecutionException;
import org.knime.core.node.ExecutionMonitor;
import org.knime.core.node.NodeLogger;
import org.knime.core.node.workflow.WorkflowManager;
import org.knime.core.util.LockFailedException;
import org.knime.core.node.workflow.contextv2.WorkflowContextV2.LocationType;
import org.knime.gateway.impl.project.Project;
import org.knime.gateway.impl.project.ProjectManager;
import org.knime.gateway.impl.webui.AppStateUpdater;
import org.knime.gateway.impl.webui.service.ServiceDependencies;

import com.ben47203.knimecli.server.api.Endpoint;
import com.ben47203.knimecli.server.api.Reflected;
import com.ben47203.knimecli.server.api.Requests;
import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;

/**
 * A project's unsaved changes, and saving it in place the way the KNIME UI's Save does.
 *
 * <p>
 * Saving mirrors the desktop UI's {@code SaveProject.saveRegularWorkflow}: {@link WorkflowManager#save} into the
 * project's own directory with data, which also runs the registered save hooks, among them the gateway's workflow SVG
 * preview. Like the UI, it then tells the gateway's app state to refresh, which sends the UI the project dirty-state
 * event that clears its unsaved marker; core's own clean event doesn't reach the UI. Only local workflows are saved:
 * the UI uploads a Hub or Server project after saving its temporary copy, and asks about overwriting, which an API
 * call can't answer, so those are refused rather than saved half way. There is no "save as".
 */
public final class ProjectApi {

    private static final NodeLogger LOGGER = NodeLogger.getLogger(ProjectApi.class);

    /**
     * {@code ServiceDependencies.getServiceDependency}, package-private: the only way to the gateway's
     * {@link AppStateUpdater}, which the desktop UI reaches through its own internal {@code DesktopAPI}.
     */
    private static final Reflected<Method> GET_SERVICE_DEPENDENCY = Reflected.find(
        "ServiceDependencies.getServiceDependency",
        "the UI's unsaved marker won't clear after a save through the API until the workflow next changes",
        () -> ServiceDependencies.class.getDeclaredMethod("getServiceDependency", Class.class, boolean.class));

    private ProjectApi() {
    }

    public static List<Endpoint<?>> endpoints() {
        return List.of(new State(), new Save());
    }

    /** For {@link com.ben47203.knimecli.server.api.Capabilities}. */
    public static Reflected<Method> getServiceDependency() {
        return GET_SERVICE_DEPENDENCY;
    }

    /** Request that names a project and nothing else. */
    public record ProjectTarget(String projectId) {
        public ProjectTarget {
            Requests.require(projectId, "projectId");
        }
    }

    /**
     * {@code POST /api/project/state}: {@code {projectId, name, dirty, path, canSave}}, plus {@code saveBlocked} saying
     * why when {@code canSave} is false, and {@code executing} while any node runs. {@code path} is the project's
     * local directory, absent if it has none.
     */
    static final class State extends Endpoint<ProjectTarget> {
        State() {
            super("project/state", Tier.READ, ProjectTarget.class);
        }

        @Override
        protected Object run(final ProjectTarget request) throws ApiException {
            var project = project(request.projectId());
            return describe(project, workflowManager(project));
        }
    }

    /**
     * {@code POST /api/project/save}: saves the project to its own directory, as the UI's Save does. 409 if it can't
     * be saved in place (see {@code saveBlocked} in project/state). Saving while nodes execute is allowed, as in the
     * UI: they're saved as not yet executed, and {@code executing} in the response says so.
     */
    static final class Save extends Endpoint<ProjectTarget> {
        Save() {
            super("project/save", Tier.WRITE, ProjectTarget.class);
        }

        @Override
        protected Object run(final ProjectTarget request) throws Exception {
            var project = project(request.projectId());
            var wfm = workflowManager(project);
            var blocked = saveBlocked(wfm);
            if (blocked != null) {
                throw new ApiException(409, "Can't save " + project.getName() + ": " + blocked);
            }
            var directory = wfm.getContextV2().getExecutorInfo().getLocalWorkflowPath().toFile();
            var success = false;
            try {
                wfm.save(directory, new ExecutionMonitor(), true);
                success = true;
            } catch (LockFailedException e) {
                throw new ApiException(409, "Can't save " + project.getName() + ": its directory is locked ("
                    + e.getMessage() + ")");
            } catch (CanceledExecutionException e) {
                throw new ApiException(409, "Saving " + project.getName() + " was cancelled");
            } finally {
                if (!success) {
                    wfm.setDirty(); // as the UI does: a failed save may have written part of the workflow
                }
                refreshUiDirtyState();
            }
            var res = describe(project, wfm);
            res.put("saved", true);
            return res;
        }
    }

    private static Project project(final String projectId) throws ApiException {
        return ProjectManager.getInstance().getProject(projectId)
            .orElseThrow(() -> new ApiException(404, "No open project with id " + projectId));
    }

    /** The project's workflow if loaded; never loads one, which would happen behind the UI's back. */
    private static WorkflowManager workflowManager(final Project project) throws ApiException {
        return project.getWorkflowManagerIfLoaded()
            .orElseThrow(() -> new ApiException(409, "Project " + project.getName() + " isn't loaded"));
    }

    /** Whether {@code wfm} or any node in it is executing, here or remotely. */
    public static boolean isExecuting(final WorkflowManager wfm) {
        var state = wfm.getNodeContainerState();
        return state.isExecutionInProgress() || state.isExecutingRemotely();
    }

    static Map<String, Object> describe(final Project project, final WorkflowManager wfm) {
        var res = new LinkedHashMap<String, Object>();
        res.put("projectId", project.getID());
        res.put("name", project.getName());
        res.put("dirty", wfm.isDirty());
        var context = wfm.getContextV2();
        if (context != null && context.getExecutorInfo().getLocalWorkflowPath() != null) {
            res.put("path", context.getExecutorInfo().getLocalWorkflowPath().toString());
        }
        var blocked = saveBlocked(wfm);
        res.put("canSave", blocked == null);
        if (blocked != null) {
            res.put("saveBlocked", blocked);
        }
        if (isExecuting(wfm)) {
            res.put("executing", true);
        }
        return res;
    }

    /** Why {@code wfm} can't be saved in place through the API, or null if it can. */
    private static String saveBlocked(final WorkflowManager wfm) {
        if (wfm.isComponentProjectWFM()) {
            return "it's a component project, which the KNIME UI saves as a template; save it there";
        }
        var context = wfm.getContextV2();
        if (context == null || context.getExecutorInfo().getLocalWorkflowPath() == null) {
            return "it has no local directory";
        }
        if (context.getLocationType() != LocationType.LOCAL || context.isTemporyWorkflowCopyMode()) {
            return "it's a temporary copy of a " + context.getLocationType()
                + " workflow, which the KNIME UI saves by uploading it; save it there";
        }
        if (wfm.isWriteProtected()) {
            return "it's read-only";
        }
        return null; // NOSONAR: null means "can save"
    }

    /**
     * Has the gateway resend the project dirty states, as the UI does after a save; otherwise the UI's unsaved marker
     * only clears with the next workflow change. Best effort, on the UI thread like the UI's own calls: the
     * updater's listeners aren't thread-safe.
     */
    private static void refreshUiDirtyState() {
        var method = GET_SERVICE_DEPENDENCY.orNull();
        if (method == null) {
            return;
        }
        try {
            if (method.invoke(null, AppStateUpdater.class, false) instanceof AppStateUpdater updater) {
                Display.getDefault().asyncExec(() -> {
                    try {
                        updater.updateAppState();
                    } catch (RuntimeException e) { // NOSONAR: the save itself succeeded
                        LOGGER.warn("knime-cli: couldn't refresh the UI's dirty state after a save", e);
                    }
                });
            }
        } catch (IllegalAccessException | InvocationTargetException | RuntimeException e) { // NOSONAR: incl. SWTException
            LOGGER.warn("knime-cli: couldn't refresh the UI's dirty state after a save", e);
        }
    }
}

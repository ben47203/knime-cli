package com.ben47203.knimecli.server.api.workflow;

import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.knime.core.node.workflow.WorkflowManager;
import org.knime.gateway.impl.project.ProjectManager;
import org.osgi.framework.FrameworkUtil;

import com.ben47203.knimecli.server.api.Endpoint;
import com.ben47203.knimecli.server.api.Reflected;
import com.ben47203.knimecli.server.api.WorkflowEndpoint;
import com.ben47203.knimecli.server.api.WorkflowEndpoint.WorkflowTarget;
import com.ben47203.knimecli.server.http.LocalApiServer.ApiResponse;

/** The workflow canvas as an image, drawn by the same renderer as the workflow preview KNIME saves with a project. */
public final class CanvasApi {

    private static final String SVG_HOOK = "org.knime.gateway.impl.webui.preview.GenerateSVGWorkflowSaveHook";

    /**
     * {@code GenerateSVGWorkflowSaveHook.renderPreviewSVG(WorkflowManager, Path)}: package-private, in a package
     * {@code org.knime.gateway.impl} doesn't export, so loaded through that bundle's own class loader.
     */
    private static final Reflected<Method> RENDER_PREVIEW_SVG = Reflected.find(
        "GenerateSVGWorkflowSaveHook.renderPreviewSVG", "workflow/svg will answer 501",
        () -> FrameworkUtil.getBundle(ProjectManager.class).loadClass(SVG_HOOK)
            .getDeclaredMethod("renderPreviewSVG", WorkflowManager.class, Path.class));

    private CanvasApi() {
    }

    public static List<Endpoint<?>> endpoints() {
        return List.of(new WorkflowSvg());
    }

    /** For {@link com.ben47203.knimecli.server.api.Capabilities}. */
    public static Reflected<Method> renderPreviewSvg() {
        return RENDER_PREVIEW_SVG;
    }

    /**
     * {@code POST /api/workflow/svg}: the canvas of a project's root workflow, or of a metanode or component, as
     * {@code image/svg+xml}: nodes with their names, states and ports, connections and annotations, as the preview
     * KNIME writes on save. 501 if this KNIME version's renderer can't be reached.
     */
    static final class WorkflowSvg extends WorkflowEndpoint<WorkflowTarget> {
        WorkflowSvg() {
            super("workflow/svg", Tier.READ, WorkflowTarget.class);
        }

        @Override
        protected Object execute(final WorkflowManager wfm, final WorkflowTarget request) throws Exception {
            var render = RENDER_PREVIEW_SVG.require();
            // The renderer builds the workflow entity under the workflow lock itself, then works on that copy only.
            var file = Files.createTempFile("knime-cli-canvas-", ".svg");
            var thread = Thread.currentThread();
            var previousLoader = thread.getContextClassLoader();
            try {
                // Its template engine looks the templates up through the context class loader first.
                thread.setContextClassLoader(render.getDeclaringClass().getClassLoader());
                render.invoke(null, wfm, file);
                return new ApiResponse("image/svg+xml; charset=utf-8", Files.readAllBytes(file));
            } catch (InvocationTargetException e) {
                if (e.getCause() instanceof Exception cause) {
                    throw cause; // a 500 naming the renderer's own failure
                }
                throw e;
            } finally {
                thread.setContextClassLoader(previousLoader);
                deleteQuietly(file);
            }
        }
    }

    private static void deleteQuietly(final Path file) {
        try {
            Files.deleteIfExists(file);
        } catch (IOException e) { // NOSONAR: a stray temp file is harmless
        }
    }
}

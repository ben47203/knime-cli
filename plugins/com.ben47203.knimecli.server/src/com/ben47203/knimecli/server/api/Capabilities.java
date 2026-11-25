package com.ben47203.knimecli.server.api;

import java.util.LinkedHashMap;
import java.util.Map;

import com.ben47203.knimecli.server.api.project.ProjectApi;
import com.ben47203.knimecli.server.api.settings.SettingsApi;
import com.ben47203.knimecli.server.api.workflow.CanvasApi;

/**
 * Every {@link Reflected} KNIME internal the endpoints rely on, probed together at server start and reported in
 * {@code /status} as {@code capabilities} (name to availability) and, for unavailable ones only,
 * {@code capabilityProblems} (name to reason). An endpoint that needs an unavailable one answers 501 with that reason.
 */
public final class Capabilities {

    private Capabilities() {
    }

    /** Name to target. Reading a field here initialises its owning class, which is when the lookup runs. */
    private static Map<String, Reflected<?>> targets() {
        var targets = new LinkedHashMap<String, Reflected<?>>();
        targets.put("settingsSaveCheck", SettingsApi.saveSettingsTo());
        targets.put("saveRefreshesUi", ProjectApi.getServiceDependency());
        targets.put("workflowSvg", CanvasApi.renderPreviewSvg());
        return targets;
    }

    /** The {@code /status} fields: {@code capabilities}, and {@code capabilityProblems} if any is unavailable. */
    public static Map<String, Object> probe() {
        var available = new LinkedHashMap<String, Object>();
        var problems = new LinkedHashMap<String, Object>();
        targets().forEach((name, target) -> {
            available.put(name, target.available());
            if (!target.available()) {
                problems.put(name, target.problem());
            }
        });
        var fields = new LinkedHashMap<String, Object>();
        fields.put("capabilities", available);
        if (!problems.isEmpty()) {
            fields.put("capabilityProblems", problems);
        }
        return fields;
    }
}

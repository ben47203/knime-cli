package com.ben47203.knimecli.server.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.knime.core.node.config.base.AbstractConfigEntry;
import org.knime.core.node.config.base.ConfigBase;
import org.knime.core.node.config.base.ConfigBaseRO;
import org.knime.core.node.config.base.ConfigBooleanEntry;
import org.knime.core.node.config.base.ConfigByteEntry;
import org.knime.core.node.config.base.ConfigCharEntry;
import org.knime.core.node.config.base.ConfigDoubleEntry;
import org.knime.core.node.config.base.ConfigEntries;
import org.knime.core.node.config.base.ConfigFloatEntry;
import org.knime.core.node.config.base.ConfigIntEntry;
import org.knime.core.node.config.base.ConfigLongEntry;
import org.knime.core.node.config.base.ConfigShortEntry;
import org.knime.core.node.config.base.ConfigStringEntry;

import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * Converts node settings to plain JSON and applies JSON patches back onto them, so agents can read and change
 * settings without knowing KNIME's typed config format.
 *
 * <p>
 * The JSON keeps KNIME's key order and is lossy only where it must be: a number doesn't say whether it was an int or
 * a long. That is why {@link #applyPatch} never creates entries: every value is coerced to the type of the entry it
 * replaces, so a patch can't change a setting's type, add keys a node doesn't know, or create a password entry.
 * Secrets (see {@link Secrets}) are redacted on the way out and refused on the way in.
 *
 * <p>
 * Paths in results and error messages are JSON Pointers (RFC 6901), e.g. {@code /model/password}.
 */
final class SettingsJson {

    /** Key of the placeholder object that stands in for a redacted secret. */
    static final String REDACTED = "$redacted";

    /** Key under which KNIME stores an array's length; the elements are keyed "0".."n-1". */
    private static final String ARRAY_SIZE = "array-size";

    /** Error suffix for secrets; deliberately says nothing about the value. */
    private static final String PROTECTED = " holds a password or credentials and can't be changed through this API";

    /** How many existing keys to list in an "unknown setting" error before cutting the list short. */
    private static final int MAX_LISTED_KEYS = 25;

    private SettingsJson() {
    }

    /**
     * {@code config} as JSON: a {@link LinkedHashMap} in KNIME's key order, or a {@link List} if the config is a KNIME
     * array. Leaves become strings, numbers, booleans or null; non-finite doubles and floats become the strings
     * {@code "NaN"}, {@code "Infinity"} and {@code "-Infinity"}, since JSON has no literal for them.
     *
     * @param redactedPaths receives the JSON Pointer of every secret replaced by {@code {"$redacted": true}}
     * @param basePath JSON Pointer of {@code config} itself, {@code ""} for the root
     */
    static Object toJson(final ConfigBaseRO config, final List<String> redactedPaths, final String basePath) {
        if (isArray(config)) {
            var size = arraySize(config);
            var list = new ArrayList<>(size);
            for (var i = 0; i < size; i++) {
                list.add(entryToJson(config, Integer.toString(i), redactedPaths, basePath));
            }
            return list;
        }
        var map = new LinkedHashMap<String, Object>();
        for (var key : config) {
            map.put(key, entryToJson(config, key, redactedPaths, basePath));
        }
        return map;
    }

    /**
     * Applies {@code patch}, a JSON object whose fields mirror {@code target}'s keys, onto {@code target}. Only the
     * given keys change; nested objects patch nested configs key by key, and arrays replace KNIME arrays whole.
     *
     * <p>
     * All-or-nothing: the whole patch is validated before {@code target} is touched, so a rejected patch leaves it as
     * it was. Rejected (400, naming the JSON Pointer) are unknown keys, secrets and settings-model internals,
     * {@code {"$redacted": true}} placeholders, shape mismatches and values that don't fit the existing entry's type.
     *
     * @param basePath JSON Pointer of {@code target}, {@code ""} for the root, used in error messages
     */
    static void applyPatch(final ConfigBase target, final JsonNode patch, final String basePath)
        throws ApiException {
        var writes = new ArrayList<Runnable>();
        planObject(target, patch, basePath, writes);
        writes.forEach(Runnable::run);
    }

    /** JSON Pointer of {@code key} under {@code parent}, escaping {@code ~} and {@code /} as RFC 6901 requires. */
    static String child(final String parent, final String key) {
        return parent + "/" + key.replace("~", "~0").replace("/", "~1");
    }

    // ---- toJson ----

    private static Object entryToJson(final ConfigBaseRO parent, final String key, final List<String> redactedPaths,
        final String basePath) {
        var path = child(basePath, key);
        if (Secrets.isSecret(parent, key)) {
            redactedPaths.add(path);
            return Map.of(REDACTED, true);
        }
        var entry = Secrets.entry(parent, key);
        if (entry instanceof ConfigBase config) {
            return toJson(config, redactedPaths, path);
        }
        return leafToJson(entry);
    }

    /** Value of a non-secret leaf. Secret types never get here, so the default branch never reads one. */
    private static Object leafToJson(final AbstractConfigEntry entry) {
        return switch (entry) {
            case ConfigStringEntry e -> e.getString();
            case ConfigIntEntry e -> e.getInt();
            case ConfigLongEntry e -> e.getLong();
            case ConfigShortEntry e -> e.getShort();
            case ConfigByteEntry e -> e.getByte();
            case ConfigDoubleEntry e -> finiteOrName(e.getDouble());
            case ConfigFloatEntry e -> Float.isFinite(e.getFloat()) ? e.getFloat() : finiteOrName(e.getFloat());
            case ConfigCharEntry e -> String.valueOf(e.getChar());
            case ConfigBooleanEntry e -> e.getBoolean();
            default -> throw new IllegalStateException("Unexpected settings entry type " + entry.getType());
        };
    }

    private static Object finiteOrName(final double value) {
        if (Double.isNaN(value)) {
            return "NaN";
        }
        if (Double.isInfinite(value)) {
            return value > 0 ? "Infinity" : "-Infinity";
        }
        return value;
    }

    /** True if {@code config}'s keys are exactly {@code array-size} (an int n ≥ 0) and "0".."n-1". */
    private static boolean isArray(final ConfigBaseRO config) {
        var size = arraySize(config);
        if (size < 0 || config.keySet().size() != size + 1) {
            return false;
        }
        for (var i = 0; i < size; i++) {
            if (!config.containsKey(Integer.toString(i))) {
                return false;
            }
        }
        return true;
    }

    /** The {@code array-size} entry, or -1 if there is no int entry of that name. */
    private static int arraySize(final ConfigBaseRO config) {
        return Secrets.entry(config, ARRAY_SIZE) instanceof ConfigIntEntry size ? size.getInt() : -1;
    }

    // ---- applyPatch: validation queues writes, which only run once the whole patch is valid ----

    private static void planObject(final ConfigBase target, final JsonNode patch, final String path,
        final List<Runnable> writes) throws ApiException {
        if (patch == null || !patch.isObject()) {
            throw new ApiException(400, where(path) + " must be a JSON object, got " + describe(patch));
        }
        for (var field : patch.properties()) {
            planField(target, field.getKey(), field.getValue(), child(path, field.getKey()), writes);
        }
    }

    private static void planField(final ConfigBase target, final String key, final JsonNode value, final String path,
        final List<Runnable> writes) throws ApiException {
        var existing = target.getEntry(key);
        if (existing == null) {
            throw new ApiException(400, "Unknown setting " + path + "; existing keys: " + listKeys(target));
        }
        if (key.endsWith(Secrets.INTERNALS_SUFFIX)) {
            throw new ApiException(400, path + " is internal settings-model state and can't be changed");
        }
        if (Secrets.isLocked(target, key)) {
            throw new ApiException(400, path + PROTECTED);
        }
        if (value.isObject() && value.has(REDACTED)) {
            throw new ApiException(400,
                path + " is a redacted placeholder; leave it out of the patch to keep the current value");
        }
        if (existing instanceof ConfigBase config) {
            if (isArray(config)) {
                planArray(target, config, value, path, writes);
            } else if (value.isObject()) {
                planObject(config, value, path, writes);
            } else {
                throw new ApiException(400,
                    path + " is a group of settings; expected a JSON object, got " + describe(value));
            }
            return;
        }
        var entry = coerce(existing.getType(), key, value, path);
        writes.add(() -> target.addEntry(entry)); // replacing a key keeps its position (LinkedHashMap)
    }

    /**
     * Replaces a KNIME array whole. The element type comes from the existing elements, which must all be leaves of
     * one type; an empty array only takes strings, the most common case and the only safe guess.
     */
    private static void planArray(final ConfigBase target, final ConfigBase array, final JsonNode value,
        final String path, final List<Runnable> writes) throws ApiException {
        if (!value.isArray()) {
            throw new ApiException(400, path + " is a list; expected a JSON array, got " + describe(value));
        }
        if (Secrets.isWriteProtected(target, array.getKey())) {
            throw new ApiException(400, path + PROTECTED);
        }
        var type = elementType(array, path);
        var replacement = array.getInstance(array.getKey());
        replacement.addInt(ARRAY_SIZE, value.size());
        for (var i = 0; i < value.size(); i++) {
            var element = value.get(i);
            var elementPath = path + "/" + i;
            if (element.isObject() && element.has(REDACTED)) {
                throw new ApiException(400, elementPath + " is a redacted placeholder and can't be written back");
            }
            replacement.addEntry(coerce(type, Integer.toString(i), element, elementPath));
        }
        writes.add(() -> target.addEntry(replacement)); // same key, so it stays in place
    }

    private static ConfigEntries elementType(final ConfigBase array, final String path) throws ApiException {
        var size = arraySize(array);
        if (size == 0) {
            return ConfigEntries.xstring;
        }
        var type = array.getEntry("0").getType();
        for (var i = 1; i < size && type != ConfigEntries.config; i++) {
            if (array.getEntry(Integer.toString(i)).getType() != type) {
                type = ConfigEntries.config; // mixed: treated like a list of groups
            }
        }
        if (type == ConfigEntries.config) {
            throw new ApiException(400, path + " is a list of groups or mixed values, which can't be changed"
                + " through this API yet");
        }
        return type;
    }

    // ---- leaf coercion: strict, so a value never silently changes meaning ----

    private static AbstractConfigEntry coerce(final ConfigEntries type, final String key, final JsonNode value,
        final String path) throws ApiException {
        return switch (type) {
            case xstring -> {
                if (value.isNull() || value.isTextual()) {
                    yield new ConfigStringEntry(key, value.isNull() ? null : value.textValue());
                }
                throw mismatch(path, "a string or null", value);
            }
            case xint -> new ConfigIntEntry(key, (int)integral(value, Integer.MIN_VALUE, Integer.MAX_VALUE, path));
            case xlong -> new ConfigLongEntry(key, integral(value, Long.MIN_VALUE, Long.MAX_VALUE, path));
            case xshort -> new ConfigShortEntry(key, (short)integral(value, Short.MIN_VALUE, Short.MAX_VALUE, path));
            case xbyte -> new ConfigByteEntry(key, (byte)integral(value, Byte.MIN_VALUE, Byte.MAX_VALUE, path));
            case xdouble -> new ConfigDoubleEntry(key, floating(value, "a number", path));
            case xfloat -> {
                var d = floating(value, "a 32-bit float", path);
                var f = (float)d;
                if (Double.isFinite(d) && !Float.isFinite(f)) {
                    throw mismatch(path, "a number within the 32-bit float range", value);
                }
                yield new ConfigFloatEntry(key, f);
            }
            case xchar -> {
                if (value.isTextual() && value.textValue().length() == 1) {
                    yield new ConfigCharEntry(key, value.textValue().charAt(0));
                }
                throw mismatch(path, "a single-character string", value);
            }
            case xboolean -> {
                if (value.isBoolean()) {
                    yield new ConfigBooleanEntry(key, value.booleanValue());
                }
                throw mismatch(path, "true or false", value);
            }
            // Types come from existing, non-secret entries, so this is unreachable; refuse rather than guess.
            default -> throw new ApiException(400, path + " can't be changed through this API");
        };
    }

    /** An integral JSON number in [{@code min}, {@code max}]; 1.0 is not integral, to keep the check strict. */
    private static long integral(final JsonNode value, final long min, final long max, final String path)
        throws ApiException {
        if (value.isIntegralNumber() && value.canConvertToLong()) {
            var l = value.longValue();
            if (l >= min && l <= max) {
                return l;
            }
        }
        throw mismatch(path, "an integer between " + min + " and " + max, value);
    }

    /** A JSON number, or one of the names {@link #toJson} uses for non-finite values. */
    private static double floating(final JsonNode value, final String what, final String path)
        throws ApiException {
        if (value.isNumber()) {
            return value.doubleValue();
        }
        if (value.isTextual()) {
            switch (value.textValue()) {
                case "NaN":
                    return Double.NaN;
                case "Infinity":
                    return Double.POSITIVE_INFINITY;
                case "-Infinity":
                    return Double.NEGATIVE_INFINITY;
                default:
                    break;
            }
        }
        throw mismatch(path, what + ", or \"NaN\", \"Infinity\" or \"-Infinity\"", value);
    }

    private static ApiException mismatch(final String path, final String expected, final JsonNode value) {
        return new ApiException(400, "Invalid value for " + path + ": expected " + expected + ", got "
            + describe(value));
    }

    /** JSON type of {@code value} for error messages, with the value itself for numbers (never for strings). */
    private static String describe(final JsonNode value) {
        if (value == null || value.isMissingNode()) {
            return "nothing";
        }
        if (value.isNumber()) {
            return "number " + value.asText();
        }
        return value.getNodeType().name().toLowerCase(Locale.ROOT);
    }

    private static String where(final String path) {
        return path.isEmpty() ? "The settings patch" : path;
    }

    private static String listKeys(final ConfigBase config) {
        var keys = new ArrayList<>(config.keySet());
        if (keys.size() <= MAX_LISTED_KEYS) {
            return String.join(", ", keys);
        }
        return String.join(", ", keys.subList(0, MAX_LISTED_KEYS)) + ", ... (" + (keys.size() - MAX_LISTED_KEYS)
            + " more)";
    }
}

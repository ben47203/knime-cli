package com.ben47203.knimecli.server.api.settings;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

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
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Converts node settings to plain JSON and applies JSON patches back onto them, so agents can read and change
 * settings without knowing KNIME's typed config format.
 *
 * <p>
 * The JSON keeps KNIME's key order and is lossy only where it must be: a number doesn't say whether it was an int or
 * a long. That is why a plain value in a patch is always coerced to the type of the entry it replaces, and can't
 * create a key. Creating a key, or changing an entry's type, takes an explicitly typed value (see
 * {@link #applyPatch}). Secrets (see {@link Secrets}) are redacted on the way out and refused on the way in, and no
 * patch can create a password entry.
 *
 * <p>
 * Paths in results and error messages are JSON Pointers (RFC 6901), e.g. {@code /model/password}.
 */
final class SettingsJson {

    /** Key of the placeholder object that stands in for a redacted secret. */
    static final String REDACTED = "$redacted";

    /** Key naming the KNIME type of a typed patch value, {@code {"$type": "int", "value": 3}}. */
    static final String TYPE = "$type";

    /** Key of a typed patch value's value. */
    static final String VALUE = "value";

    /** Suffix of a KNIME array type name, e.g. {@code string[]}. */
    private static final String ARRAY_SUFFIX = "[]";

    /** Type name of a nested group of settings. */
    private static final String CONFIG = "config";

    /** Leaf type names a typed value may use, mapped to KNIME's entry types. Passwords are deliberately absent. */
    private static final Map<String, ConfigEntries> LEAF_TYPES = Map.of("string", ConfigEntries.xstring, "int",
        ConfigEntries.xint, "long", ConfigEntries.xlong, "double", ConfigEntries.xdouble, "float", ConfigEntries.xfloat,
        "boolean", ConfigEntries.xboolean, "char", ConfigEntries.xchar, "short", ConfigEntries.xshort, "byte",
        ConfigEntries.xbyte);

    /** Every type name a typed value may use, for error messages. */
    private static final String TYPE_NAMES = "string, int, long, double, float, boolean, char, short, byte, config,"
        + " or an array of one of these, e.g. string[], boolean[] or config[]";

    /** Hint appended to errors a typed value would get around. */
    private static final String TYPED_HINT = "; to create a key or change its type, give a typed value such as"
        + " {\"$type\": \"string\", \"value\": \"...\"} (types: " + TYPE_NAMES + ")";

    /** Key under which KNIME stores an array's length; the elements are keyed "0".."n-1". */
    private static final String ARRAY_SIZE = "array-size";

    /** Error suffix for secrets; deliberately says nothing about the value. */
    private static final String PROTECTED = " holds a password or credentials and can't be changed through this API";

    /** How many existing keys to list in an "unknown setting" error before cutting the list short. */
    private static final int MAX_LISTED_KEYS = 25;

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private SettingsJson() {
    }

    /**
     * {@code config} as JSON: an object in KNIME's key order, or an array if the config is a KNIME array. Leaves
     * become strings, numbers, booleans or null; non-finite doubles and floats become the strings {@code "NaN"},
     * {@code "Infinity"} and {@code "-Infinity"}, since JSON has no literal for them.
     *
     * <p>
     * A Jackson tree rather than maps, because a tree keeps its null values whatever the serialisation inclusion of the
     * mapper that writes it: the gateway's mapper drops nulls from maps, which hid settings that hold null.
     *
     * @param redactedPaths receives the JSON Pointer of every secret replaced by {@code {"$redacted": true}}
     * @param basePath JSON Pointer of {@code config} itself, {@code ""} for the root
     */
    static JsonNode toJson(final ConfigBaseRO config, final List<String> redactedPaths, final String basePath) {
        if (isArray(config)) {
            var size = arraySize(config);
            var list = JSON.arrayNode(size);
            for (var i = 0; i < size; i++) {
                list.add(entryToJson(config, Integer.toString(i), redactedPaths, basePath));
            }
            return list;
        }
        var map = JSON.objectNode();
        for (var key : config) {
            map.set(key, entryToJson(config, key, redactedPaths, basePath));
        }
        return map;
    }

    /** An empty JSON object, for a node without a given settings section. */
    static JsonNode emptyObject() {
        return JSON.objectNode();
    }

    /**
     * Applies {@code patch}, a JSON object whose fields mirror {@code target}'s keys, onto {@code target}. Only the
     * given keys change; nested objects patch nested configs key by key, and arrays replace KNIME arrays whole.
     *
     * <p>
     * A plain value replaces an existing entry and is coerced strictly to its type: a patch of plain values can't add
     * keys or change a setting's type. An empty KNIME array takes strings only.
     *
     * <p>
     * A typed value, {@code {"$type": "<type>", "value": <v>}}, creates the key, or replaces an existing entry of any
     * type, with an entry of exactly that type:
     * <ul>
     * <li>leaf types {@code string}, {@code int}, {@code long}, {@code double}, {@code float}, {@code boolean},
     * {@code char}, {@code short}, {@code byte}, whose value is coerced as above ({@code string} also takes null);</li>
     * <li>array types, the leaf types with {@code []} appended (e.g. {@code boolean[]}), whose value is a JSON array,
     * stored as KNIME stores arrays: {@code array-size} plus elements keyed "0".."n-1";</li>
     * <li>{@code config}, whose value is a JSON object, and {@code config[]}, whose value is a JSON array of objects.
     * Their fields may be typed values themselves or plain ones, whose type is inferred: string or null &rarr;
     * string, true/false &rarr; boolean, an integral number &rarr; int (long if it doesn't fit), any other number
     * &rarr; double, an object &rarr; config, and a non-empty array of one of these &rarr; that array type.</li>
     * </ul>
     * No typed value can create a password or transient string, a key whose name looks like a secret's, a
     * settings-model {@code _Internals} key, or anything inside a Credentials widget config; nor replace a secret, or
     * a config with a secret inside.
     *
     * <p>
     * All-or-nothing: the whole patch is validated before {@code target} is touched, so a rejected patch leaves it as
     * it was. Rejected (400, naming the JSON Pointer) are unknown keys given a plain value, secrets and
     * settings-model internals, {@code {"$redacted": true}} placeholders, shape mismatches, values that don't fit the
     * existing entry's (or the given) type, and malformed typed values.
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

    private static JsonNode entryToJson(final ConfigBaseRO parent, final String key, final List<String> redactedPaths,
        final String basePath) {
        var path = child(basePath, key);
        if (Secrets.isSecret(parent, key)) {
            redactedPaths.add(path);
            return JSON.objectNode().put(REDACTED, true);
        }
        var entry = Secrets.entry(parent, key);
        if (entry instanceof ConfigBase config) {
            return toJson(config, redactedPaths, path);
        }
        return leafToJson(entry);
    }

    /** Value of a non-secret leaf. Secret types never get here, so the default branch never reads one. */
    private static JsonNode leafToJson(final AbstractConfigEntry entry) {
        return switch (entry) {
            case ConfigStringEntry e -> e.getString() == null ? JSON.nullNode() : JSON.textNode(e.getString());
            case ConfigIntEntry e -> JSON.numberNode(e.getInt());
            case ConfigLongEntry e -> JSON.numberNode(e.getLong());
            case ConfigShortEntry e -> JSON.numberNode(e.getShort());
            case ConfigByteEntry e -> JSON.numberNode((int)e.getByte());
            case ConfigDoubleEntry e -> Double.isFinite(e.getDouble()) ? JSON.numberNode(e.getDouble())
                : nonFiniteName(e.getDouble());
            case ConfigFloatEntry e -> Float.isFinite(e.getFloat()) ? JSON.numberNode(e.getFloat())
                : nonFiniteName(e.getFloat());
            case ConfigCharEntry e -> JSON.textNode(String.valueOf(e.getChar()));
            case ConfigBooleanEntry e -> JSON.booleanNode(e.getBoolean());
            default -> throw new IllegalStateException("Unexpected settings entry type " + entry.getType());
        };
    }

    private static JsonNode nonFiniteName(final double value) {
        if (Double.isNaN(value)) {
            return JSON.textNode("NaN");
        }
        return JSON.textNode(value > 0 ? "Infinity" : "-Infinity");
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
        if (isTyped(value)) {
            planTyped(target, key, value, path, writes);
            return;
        }
        var existing = target.getEntry(key);
        if (existing == null) {
            throw new ApiException(400, "Unknown setting " + path + "; existing keys: " + listKeys(target)
                + TYPED_HINT);
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

    /** Creates or replaces {@code key} with a typed value, after checking secrets allow it. */
    private static void planTyped(final ConfigBase target, final String key, final JsonNode typed, final String path,
        final List<Runnable> writes) throws ApiException {
        if (key.endsWith(Secrets.INTERNALS_SUFFIX)) {
            throw new ApiException(400, path + " is internal settings-model state and can't be created or changed");
        }
        if (target.containsKey(key)) {
            // Covers secrets, protected configs, and configs with a secret anywhere inside.
            if (Secrets.isWriteProtected(target, key)) {
                throw new ApiException(400, path + PROTECTED);
            }
        } else {
            checkCreatable(target, key, path);
        }
        var entry = buildTyped(target, key, typed, path);
        writes.add(() -> target.addEntry(entry)); // a replaced key keeps its position, a new one goes last
    }

    private static void checkCreatable(final ConfigBase parent, final String key, final String path)
        throws ApiException {
        var reason = Secrets.whyNotCreatable(parent, key);
        if (reason != null) {
            throw new ApiException(400, path + " can't be created through this API: " + reason);
        }
    }

    // ---- typed values: {"$type": "<type>", "value": <v>} ----

    private static boolean isTyped(final JsonNode value) {
        return value != null && value.isObject() && value.has(TYPE);
    }

    /** The entry a typed value describes, built detached from {@code parent} so nothing changes until it's added. */
    private static AbstractConfigEntry buildTyped(final ConfigBase parent, final String key, final JsonNode typed,
        final String path) throws ApiException {
        var type = typed.get(TYPE);
        if (!type.isTextual()) {
            throw new ApiException(400, path + ": \"" + TYPE + "\" must be a type name (" + TYPE_NAMES + "), got "
                + describe(type));
        }
        if (!typed.has(VALUE) || typed.size() != 2) {
            throw new ApiException(400, path + ": a typed value has exactly two fields, \"" + TYPE + "\" and \""
                + VALUE + "\", e.g. {\"$type\": \"int\", \"value\": 3}");
        }
        return build(parent, key, type.textValue(), typed.get(VALUE), path);
    }

    /** An entry of the named type holding {@code value}. */
    private static AbstractConfigEntry build(final ConfigBase parent, final String key, final String typeName,
        final JsonNode value, final String path) throws ApiException {
        if (value.isObject() && value.has(REDACTED)) {
            throw new ApiException(400, path + " is a redacted placeholder and can't be written");
        }
        if (CONFIG.equals(typeName)) {
            return buildConfig(parent.getInstance(key), value, path);
        }
        if (typeName.endsWith(ARRAY_SUFFIX)) {
            return buildArray(parent, key, typeName.substring(0, typeName.length() - ARRAY_SUFFIX.length()), value,
                path);
        }
        return coerce(leafType(typeName, path), key, value, path);
    }

    private static ConfigEntries leafType(final String typeName, final String path) throws ApiException {
        var type = LEAF_TYPES.get(typeName);
        if (type != null) {
            return type;
        }
        var lower = typeName.toLowerCase(Locale.ROOT);
        if (lower.contains("password") || lower.contains("transient")) {
            throw new ApiException(400, path + ": passwords and credentials can't be created through this API");
        }
        throw new ApiException(400, path + ": unknown type \"" + typeName + "\"; use " + TYPE_NAMES);
    }

    /** A KNIME array: {@code array-size} plus elements "0".."n-1" of the element type. */
    private static ConfigBase buildArray(final ConfigBase parent, final String key, final String elementType,
        final JsonNode value, final String path) throws ApiException {
        if (!value.isArray()) {
            throw mismatch(path, "a JSON array for type " + elementType + ARRAY_SUFFIX, value);
        }
        if (!CONFIG.equals(elementType)) {
            leafType(elementType, path); // fail on a bad element type even for an empty array
        }
        var array = parent.getInstance(key);
        array.addInt(ARRAY_SIZE, value.size());
        for (var i = 0; i < value.size(); i++) {
            var element = value.get(i);
            var elementPath = path + "/" + i;
            if (isTyped(element)) {
                throw new ApiException(400, elementPath + ": the elements of a typed array take plain values;"
                    + " the array's type sets theirs");
            }
            array.addEntry(build(array, Integer.toString(i), elementType, element, elementPath));
        }
        return array;
    }

    /** {@code config} filled from a JSON object whose fields are typed values or plain ones of inferred type. */
    private static ConfigBase buildConfig(final ConfigBase config, final JsonNode value, final String path)
        throws ApiException {
        if (!value.isObject()) {
            throw mismatch(path, "a JSON object for type config", value);
        }
        for (var field : value.properties()) {
            var key = field.getKey();
            var fieldPath = child(path, key);
            checkCreatable(config, key, fieldPath);
            var fieldValue = field.getValue();
            config.addEntry(isTyped(fieldValue) ? buildTyped(config, key, fieldValue, fieldPath)
                : build(config, key, inferType(fieldValue, fieldPath), fieldValue, fieldPath));
        }
        return config;
    }

    /** The type name a plain value inside a typed config gets; see {@link #applyPatch}. */
    private static String inferType(final JsonNode value, final String path) throws ApiException {
        if (value.isArray()) {
            if (value.isEmpty()) {
                throw new ApiException(400, path + ": can't tell the element type of an empty array; give it one,"
                    + " e.g. {\"$type\": \"string[]\", \"value\": []}");
            }
            var types = new LinkedHashSet<String>();
            for (var element : value) {
                types.add(element.isArray() ? "array" : inferType(element, path));
            }
            if (types.equals(Set.of("int", "long"))) {
                return "long" + ARRAY_SUFFIX;
            }
            if (types.size() == 1 && !types.contains("array")) {
                return types.iterator().next() + ARRAY_SUFFIX;
            }
            if (types.stream().allMatch(t -> "int".equals(t) || "long".equals(t) || "double".equals(t))) {
                return "double" + ARRAY_SUFFIX;
            }
            throw new ApiException(400, path + ": mixed or nested array elements; give the array an explicit type,"
                + " e.g. {\"$type\": \"string[]\", \"value\": [...]}");
        }
        if (value.isObject()) {
            return CONFIG;
        }
        if (value.isNull() || value.isTextual()) {
            return "string";
        }
        if (value.isBoolean()) {
            return "boolean";
        }
        if (value.isIntegralNumber()) {
            if (value.canConvertToInt()) {
                return "int";
            }
            if (value.canConvertToLong()) {
                return "long";
            }
        } else if (value.isNumber()) {
            return "double";
        }
        throw new ApiException(400, path + ": can't infer a type for " + describe(value) + "; give it a typed value");
    }

    /**
     * Replaces a KNIME array whole. The element type comes from the existing elements, which must all be leaves of
     * one type; an empty array only takes strings, the most common case and the only safe guess. Any other type takes
     * a typed value.
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
            if (isTyped(element)) {
                throw new ApiException(400, elementPath + ": to change the element type, give the whole array a"
                    + " typed value, e.g. {\"$type\": \"boolean[]\", \"value\": [...]}");
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
            throw new ApiException(400, path + " is a list of groups or mixed values, so a plain JSON array can't"
                + " replace it; give a typed value instead, e.g. {\"$type\": \"config[]\", \"value\": [{...}]}");
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
            // Types come from existing non-secret entries or LEAF_TYPES, so this is unreachable; refuse, don't guess.
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

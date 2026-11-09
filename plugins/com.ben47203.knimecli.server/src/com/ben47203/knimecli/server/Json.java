package com.ben47203.knimecli.server;

import java.util.Map;
import java.util.stream.Collectors;

/** Tiny JSON writer for flat objects of strings, numbers, booleans and nulls. Avoids a Jackson dependency. */
final class Json {

    private Json() {
    }

    static String object(final Map<String, ?> fields) {
        return fields.entrySet().stream() //
            .map(e -> string(e.getKey()) + ":" + value(e.getValue())) //
            .collect(Collectors.joining(",", "{", "}"));
    }

    private static String value(final Object v) {
        if (v == null) {
            return "null";
        }
        if (v instanceof Number || v instanceof Boolean) {
            return v.toString();
        }
        return string(v.toString());
    }

    static String string(final String s) {
        var sb = new StringBuilder(s.length() + 2).append('"');
        for (var i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int)c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.append('"').toString();
    }
}

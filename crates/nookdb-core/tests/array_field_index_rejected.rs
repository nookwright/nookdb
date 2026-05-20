//! T13 — `CollectionBuilder.index('arr_field')` must reject at schema
//! compile time. The composite-key index codec stores scalars only;
//! supporting array indexes requires multi-row index entries (M6+ work).

use nookdb_core::schema::ir::SchemaIr;

#[test]
fn array_field_cannot_be_indexed() {
    let descriptor = r#"{"c":{"idField":"id","fields":[
        {"name":"id","type":"id"},
        {"name":"tags","type":"array","items":{"type":"string"}}],
        "indexes":[{"field":"tags","unique":false}]}}"#;

    let err = SchemaIr::compile(descriptor).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("tags") && (msg.contains("array") || msg.contains("cannot")),
        "expected index-on-array rejection mentioning 'tags' + 'array' or 'cannot', got: {msg}",
    );
}

#[test]
fn array_field_cannot_be_uniquely_indexed() {
    let descriptor = r#"{"c":{"idField":"id","fields":[
        {"name":"id","type":"id"},
        {"name":"tags","type":"array","items":{"type":"string"}}],
        "indexes":[{"field":"tags","unique":true}]}}"#;

    let err = SchemaIr::compile(descriptor).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("tags") && (msg.contains("array") || msg.contains("cannot")),
        "expected index-on-array rejection mentioning 'tags', got: {msg}",
    );
}

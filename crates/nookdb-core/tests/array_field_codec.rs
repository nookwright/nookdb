//! T15 — S2d array round-trip + nested array via the M2 schema-driven JSON
//! codec. The composite-key codec already stores documents as JSON values,
//! so array fields serialize as JSON arrays directly — no new binary format.

use nookdb_core::schema::ir::SchemaIr;
use nookdb_core::schema::validate::validate_document;
use serde_json::json;

#[test]
fn array_field_codec_round_trips_via_validate() {
    let ir = SchemaIr::compile(
        r#"{"c":{"idField":"id","fields":[
          {"name":"id","type":"id"},
          {"name":"tags","type":"array","items":{"type":"string"}}],
          "indexes":[]}}"#,
    )
    .unwrap();
    let c = ir.collection("c").unwrap();

    let doc = json!({"id": "x", "tags": ["a", "b"]});
    validate_document(c, &doc).unwrap();

    let serialized = serde_json::to_string(&doc).unwrap();
    let reparsed: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(reparsed, doc);
    validate_document(c, &reparsed).unwrap();
}

#[test]
fn nested_array_codec_round_trips() {
    let ir = SchemaIr::compile(
        r#"{"c":{"idField":"id","fields":[
          {"name":"id","type":"id"},
          {"name":"matrix","type":"array","items":{"type":"array","items":{"type":"number"}}}],
          "indexes":[]}}"#,
    )
    .unwrap();
    let c = ir.collection("c").unwrap();
    let doc = json!({"id": "x", "matrix": [[1.0, 2.0], [3.0]]});
    validate_document(c, &doc).unwrap();
}

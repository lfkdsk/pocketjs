//! Acceptance against the P1 byte vectors (`tests/fixtures/relay/vectors/`).
//!
//! The same records the TypeScript codec in `framework/src/relay/frame.ts` and
//! the C frame layer are held to. A legal vector must decode to the pinned
//! header and re-encode to the identical bytes; an illegal one must be refused
//! with the exact code the fixture names.

mod common;

use common::{Case, DEFERRED_TO_METADATA_LAYER, VECTORS};
use pocket_relay::{decode, encode_into, FrameError, FrameInput, FrameOptions, RecordReader,
    HEADER_BYTES};

#[test]
fn links_every_vector_in_the_index() {
    common::assert_covers_index();
    assert_eq!(VECTORS.len(), 46, "P1 committed 46 vectors");
}

#[test]
fn decodes_every_vector_to_its_pinned_outcome() {
    let (mut legal, mut refused, mut deferred) = (0, 0, 0);
    for vector in VECTORS {
        let case = vector.case();
        assert_eq!(
            case.bin.len(),
            case.wire_bytes,
            "{}: .bin length disagrees with the fixture's wireBytes",
            case.name
        );
        let got = decode(case.bin, &case.options);

        match &case.outcome {
            Ok(want) => {
                let frame = got.unwrap_or_else(|e| {
                    panic!("{}: expected a frame, got {}", case.name, e.as_str())
                });
                let h = frame.header;
                assert_eq!(h.kind, want.kind, "{}: type", case.name);
                assert_eq!(h.codec, want.codec, "{}: codec", case.name);
                assert_eq!(h.session, want.session, "{}: session", case.name);
                assert_eq!(h.seq, want.seq, "{}: seq", case.name);
                assert_eq!(h.stream, want.stream, "{}: stream", case.name);
                assert_eq!(h.correlation, want.correlation, "{}: correlation", case.name);
                assert_eq!(h.meta_bytes, want.meta_bytes, "{}: metaBytes", case.name);
                assert_eq!(h.data_bytes, want.data_bytes, "{}: dataBytes", case.name);
                // The two regions are views straight into the record.
                assert_eq!(frame.meta.len(), want.meta_bytes as usize, "{}: meta len", case.name);
                assert_eq!(frame.data.len(), want.data_bytes as usize, "{}: data len", case.name);
                let meta_end = HEADER_BYTES + want.meta_bytes as usize;
                assert_eq!(frame.meta, &case.bin[HEADER_BYTES..meta_end], "{}: meta", case.name);
                assert_eq!(frame.data, &case.bin[meta_end..], "{}: data", case.name);
                assert_eq!(h.wire_bytes(), case.wire_bytes as u64, "{}: wireBytes", case.name);
                legal += 1;
            }
            Err(code) if DEFERRED_TO_METADATA_LAYER.contains(&code.as_str()) => {
                // This crate reads no JSON, so these records are well-formed at
                // the frame layer by construction; the session layer above
                // refuses them. Asserting the header passes keeps the handoff
                // honest: if one of these ever became a header-level defect,
                // this assertion would notice.
                let frame = got.unwrap_or_else(|e| {
                    panic!(
                        "{}: {code} is a metadata-layer refusal, but the header was rejected with {}",
                        case.name,
                        e.as_str()
                    )
                });
                assert!(!frame.meta.is_empty(), "{}: a metadata defect implies metadata", case.name);
                deferred += 1;
            }
            Err(code) => {
                let err = got.err().unwrap_or_else(|| {
                    panic!("{}: expected {code}, but the record decoded", case.name)
                });
                assert_eq!(err.as_str(), code, "{}: wrong refusal code", case.name);
                refused += 1;
            }
        }
    }
    assert_eq!((legal, refused, deferred), (23, 17, 6), "vector census");
}

#[test]
fn re_encodes_every_legal_vector_byte_for_byte() {
    let mut out = vec![0u8; 128 * 1024];
    let mut count = 0;
    for vector in VECTORS {
        let case = vector.case();
        if case.outcome.is_err() {
            continue;
        }
        let frame = decode(case.bin, &case.options).expect("legal vector decodes");
        let input = FrameInput {
            kind: frame.header.kind,
            codec: frame.header.codec,
            session: frame.header.session,
            seq: frame.header.seq,
            stream: frame.header.stream,
            correlation: frame.header.correlation,
            meta: frame.meta,
            data: frame.data,
        };
        let n = encode_into(&input, &mut out, &case.options)
            .unwrap_or_else(|e| panic!("{}: encode failed with {e}", case.name));
        assert_eq!(n, case.bin.len(), "{}: encoded length", case.name);
        assert_eq!(&out[..n], case.bin, "{}: encoded bytes differ from the fixture", case.name);
        count += 1;
    }
    assert_eq!(count, 23);
}

/// Every single-byte change to a header must change what the decoder reports.
/// There is no inert byte in the 48: a mutated `type` or `codec` lands on a
/// different accepted value, and every other field either breaks the length
/// identity, a fixed constant, or a validated rule.
#[test]
fn every_header_byte_is_load_bearing() {
    let mut mutants = 0;
    let mut record = Vec::new();
    for vector in VECTORS {
        let case = vector.case();
        let Ok(_) = case.outcome else { continue };
        let baseline = decode(case.bin, &case.options).expect("legal vector decodes");

        for offset in 0..HEADER_BYTES {
            for mask in [0x01u8, 0xff] {
                record.clear();
                record.extend_from_slice(case.bin);
                record[offset] ^= mask;
                let got = decode(&record, &case.options);
                let changed = match got {
                    Err(_) => true,
                    Ok(frame) => frame.header != baseline.header,
                };
                assert!(
                    changed,
                    "{}: header byte {offset} ^ {mask:#04x} decoded identically",
                    case.name
                );
                mutants += 1;
            }
        }
    }
    assert_eq!(mutants, 23 * HEADER_BYTES * 2, "mutant census");
}

/// The reader must cut the same records out of the stream no matter where the
/// transport splits it.
#[test]
fn reassembles_records_at_every_split_width() {
    let legal: Vec<Case> = VECTORS
        .iter()
        .map(|v| v.case())
        .filter(|c| c.outcome.is_ok() && c.wire_bytes <= 65536)
        .collect();
    let mut stream = Vec::new();
    for case in &legal {
        stream.extend_from_slice(case.bin);
    }

    let mut storage = vec![0u8; 65536];
    for width in [1usize, 2, 3, 7, 47, 48, 49, 64, 512, 4096, stream.len()] {
        let mut reader = RecordReader::new(&mut storage).expect("buffer holds a header");
        let mut seen = 0;
        let mut offset = 0;
        while offset < stream.len() {
            let end = (offset + width).min(stream.len());
            let mut chunk = &stream[offset..end];
            offset = end;
            while !chunk.is_empty() {
                let taken = reader.feed(chunk).expect("well-formed stream");
                chunk = &chunk[taken..];
                if let Some(record) = reader.record() {
                    assert_eq!(record, legal[seen].bin, "split {width}: record {seen}");
                    seen += 1;
                    reader.consume_record();
                } else {
                    assert!(taken > 0, "split {width}: reader made no progress");
                }
            }
        }
        assert_eq!(seen, legal.len(), "split {width}: record count");
    }
}

/// A forged prefix is refused against the buffer's own size, before any byte
/// of the claimed payload is copied.
#[test]
fn reader_refuses_a_prefix_larger_than_its_buffer() {
    let mut storage = [0u8; 256];
    let mut reader = RecordReader::new(&mut storage).unwrap();
    assert_eq!(reader.max_wire_bytes(), 256);
    assert_eq!(reader.feed(&u32::MAX.to_le_bytes()), Err(FrameError::WireTooLarge));
    assert!(reader.record().is_none());

    let mut reader = RecordReader::new(&mut storage).unwrap();
    assert_eq!(reader.feed(&0u32.to_le_bytes()), Err(FrameError::BadPrefix));

    let mut tiny = [0u8; 47];
    assert_eq!(RecordReader::new(&mut tiny).unwrap_err(), FrameError::ShortHeader);
}

/// A record handed to `decode` must be exactly one record.
#[test]
fn decode_rejects_a_slice_that_is_not_one_record() {
    let case = VECTORS[0].case();
    let short = &case.bin[..case.bin.len() - 1];
    assert_eq!(decode(short, &case.options), Err(FrameError::Truncated));

    let mut long = case.bin.to_vec();
    long.push(0);
    assert_eq!(decode(&long, &case.options), Err(FrameError::BadLength));

    assert_eq!(decode(&[], &FrameOptions::default()), Err(FrameError::ShortHeader));
    assert_eq!(decode(&[0u8; 47], &FrameOptions::default()), Err(FrameError::ShortHeader));
}

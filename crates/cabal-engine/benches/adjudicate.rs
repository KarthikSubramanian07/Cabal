use criterion::{Criterion, criterion_group, criterion_main};

fn bench_placeholder(c: &mut Criterion) {
    c.bench_function("version", |b| b.iter(|| cabal_engine::VERSION.len()));
}

criterion_group!(benches, bench_placeholder);
criterion_main!(benches);

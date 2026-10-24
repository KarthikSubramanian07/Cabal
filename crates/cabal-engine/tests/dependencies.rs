use cabal_engine::adjudicate::movement::{
    MovementDependencies, resolve_movement, resolve_movement_with_dependencies,
};
use cabal_engine::geo::Map;
use cabal_engine::order::Unit;
use cabal_engine::parse::parse;
use cabal_engine::{Position, Rulebook};

fn graph(lines: &[&str]) -> (Position, MovementDependencies) {
    let map = Map::standard();
    let mut position = Position::default();
    let mut orders = Vec::new();
    for text in lines {
        let parsed = parse(map, text).unwrap();
        position.add_unit(Unit {
            power: parsed.power.unwrap(),
            kind: parsed.kind.unwrap(),
            region: parsed.region.unwrap(),
        });
        orders.push(parsed.to_movement(None).unwrap());
    }
    let (result, dependencies) =
        resolve_movement_with_dependencies(map, &position, Rulebook::default(), &orders);
    assert_eq!(
        result,
        resolve_movement(map, &position, Rulebook::default(), &orders)
    );
    let dot = dependencies.to_dot(map, &position);
    for _ in 0..8 {
        orders.reverse();
        position.units.reverse();
        let (again, graph) =
            resolve_movement_with_dependencies(map, &position, Rulebook::default(), &orders);
        assert_eq!(again, result);
        assert_eq!(graph, dependencies);
        assert_eq!(graph.to_dot(map, &position), dot);
    }
    (position, dependencies)
}

fn edge(graph: &MovementDependencies, from: &str, to: &str) -> bool {
    let map = Map::standard();
    let index = |name| {
        graph
            .orders
            .iter()
            .position(|o| o.unit == map.find_province(name).unwrap())
            .unwrap()
    };
    graph.edges.contains(&(index(from), index(to)))
}

#[test]
fn supported_attack_depends_on_support() {
    let (position, graph) = graph(&[
        "FRA: A PAR - BUR",
        "FRA: A MAR S A PAR - BUR",
        "GER: A BUR H",
    ]);
    assert!(edge(&graph, "par", "mar"));
    assert!(
        graph
            .edges
            .iter()
            .all(|&(a, b)| a < graph.orders.len() && b < graph.orders.len())
    );
    let dot = graph.to_dot(Map::standard(), &position);
    assert!(dot.starts_with("digraph movement {\n"));
    assert!(dot.ends_with("}\n"));
    assert!(dot.contains("PAR"));
    assert!(dot.contains("label=\""));
}

#[test]
fn cycles_and_convoys_are_traced() {
    let (_, circular) = graph(&["TUR: F ANK - CON", "TUR: A CON - SMY", "TUR: A SMY - ANK"]);
    assert!(edge(&circular, "ank", "con"));
    assert!(edge(&circular, "con", "smy"));
    assert!(edge(&circular, "smy", "ank"));
    let (_, convoy) = graph(&["ENG: A LON - BEL VIA", "ENG: F NTH C A LON - BEL"]);
    assert!(edge(&convoy, "lon", "nth"));
}

#[test]
fn empty_and_illegal_orders_have_nodes_without_spurious_edges() {
    let (position, empty) = graph(&[]);
    assert_eq!(
        empty.to_dot(Map::standard(), &position),
        "digraph movement {\n}\n"
    );
    let (_, illegal) = graph(&["FRA: A PAR - PAR"]);
    assert_eq!(illegal.orders.len(), 1);
    assert!(illegal.edges.is_empty());
}

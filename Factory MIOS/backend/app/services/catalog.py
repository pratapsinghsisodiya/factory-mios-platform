"""Widget + dashboard-template catalog.

This is the seed of the "thousands of widgets across industries" vision. It is
a data-driven catalog: each industry contributes machine types and widgets, and
dashboard templates are pre-wired widget layouts. Extend by adding entries here
(or load from a JSON pack) without touching application code.
"""

WIDGET_TYPES = [
    {"type": "gauge", "name": "Gauge", "category": "kpi"},
    {"type": "stat", "name": "Single Stat", "category": "kpi"},
    {"type": "line", "name": "Line Chart", "category": "trend"},
    {"type": "bar", "name": "Bar Chart", "category": "trend"},
    {"type": "oee_donut", "name": "OEE Donut (A×P×Q)", "category": "oee"},
    {"type": "waterfall", "name": "Loss Waterfall", "category": "oee"},
    {"type": "pareto", "name": "Downtime Pareto", "category": "downtime"},
    {"type": "heatmap", "name": "Utilization Heatmap", "category": "performance"},
    {"type": "table", "name": "Data Table", "category": "data"},
    {"type": "map", "name": "Device GPS Map", "category": "asset"},
    {"type": "status_grid", "name": "Machine Status Grid", "category": "realtime"},
    {"type": "energy", "name": "Energy / EMS Tile", "category": "ems"},
    {"type": "inventory", "name": "WMS Stock Level", "category": "wms"},
    {"type": "spc", "name": "SPC Control Chart", "category": "quality"},
]

INDUSTRIES = [
    {"key": "automotive", "name": "Automotive", "machine_types": ["CNC", "Press", "Welding Robot", "Paint Booth", "Assembly Line"]},
    {"key": "cnc_machining", "name": "CNC / Machining", "machine_types": ["CNC Mill", "CNC Lathe", "EDM", "Grinder"]},
    {"key": "injection_molding", "name": "Plastics / Injection Molding", "machine_types": ["Injection Molder", "Extruder", "Blow Molder"]},
    {"key": "packaging", "name": "Packaging", "machine_types": ["Filler", "Capper", "Labeler", "Cartoner"]},
    {"key": "food_beverage", "name": "Food & Beverage", "machine_types": ["Mixer", "Oven", "Pasteurizer", "Bottling Line"]},
    {"key": "textile", "name": "Textile", "machine_types": ["Loom", "Spinning Frame", "Dyeing Machine"]},
    {"key": "pharma", "name": "Pharmaceutical", "machine_types": ["Tablet Press", "Coater", "Blister Pack", "Autoclave"]},
    {"key": "steel_metal", "name": "Steel / Metal", "machine_types": ["Furnace", "Rolling Mill", "CNC Plasma"]},
    {"key": "electronics", "name": "Electronics / SMT", "machine_types": ["Pick & Place", "Reflow Oven", "AOI", "Wave Solder"]},
    {"key": "energy_utilities", "name": "Energy & Utilities", "machine_types": ["Generator", "Compressor", "Chiller", "Transformer"]},
    {"key": "warehouse", "name": "Warehouse / Logistics", "machine_types": ["Conveyor", "AGV", "Sorter", "Forklift"]},
]

TEMPLATES = [
    {"key": "oee", "name": "OEE Overview", "widgets": ["oee_donut", "stat", "stat", "stat", "line", "waterfall"]},
    {"key": "downtime", "name": "Downtime Analysis", "widgets": ["pareto", "table", "bar", "stat"]},
    {"key": "quality", "name": "Quality Report", "widgets": ["spc", "stat", "bar", "table"]},
    {"key": "performance", "name": "Performance", "widgets": ["heatmap", "line", "gauge", "stat"]},
    {"key": "realtime", "name": "Real-Time Monitoring", "widgets": ["status_grid", "map", "gauge", "line"]},
    {"key": "ems", "name": "Energy Management (EMS)", "widgets": ["energy", "line", "bar", "stat"]},
    {"key": "wms", "name": "Warehouse (WMS)", "widgets": ["inventory", "table", "bar", "map"]},
]


def catalog() -> dict:
    return {
        "widget_types": WIDGET_TYPES,
        "industries": INDUSTRIES,
        "templates": TEMPLATES,
        "counts": {
            "widget_types": len(WIDGET_TYPES),
            "industries": len(INDUSTRIES),
            "machine_types": sum(len(i["machine_types"]) for i in INDUSTRIES),
            "templates": len(TEMPLATES),
        },
    }

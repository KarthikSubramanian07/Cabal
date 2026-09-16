"""How real geography becomes the classic Diplomacy board.

Every Natural Earth admin-1 region is assigned to one Diplomacy province. Where the
board follows a historic border we assign by name; elsewhere a region joins the
nearest *seed* (a lon/lat point) among the provinces its country may belong to.
Codes starting with an underscore are impassable land drawn on the board
(Ireland, Iceland, the Mediterranean islands, the edges of the world).

Sea zones are cut from open water by the straight boundary lines in
SEA_BOUNDARIES and named by the SEA_SEEDS they contain.
"""

# ---------------------------------------------------------------- land ----

# Whole countries that belong to one province.
COUNTRY_TO_PROVINCE = {
    "BEL": "BEL", "LUX": "BEL", "NLD": "HOL", "DNK": "DEN", "SWE": "SWE", "NOR": "NWY",
    "FIN": "FIN", "ALD": "FIN", "EST": "LVN", "LVA": "LVN", "LTU": "LVN",
    "CHE": "SWI", "LIE": "SWI", "HUN": "BUD", "SVK": "GAL", "CZE": "BOH",
    "SVN": "TRI", "HRV": "TRI", "BIH": "TRI", "MNE": "ALB", "ALB": "ALB",
    "SRB": "SER", "KOS": "SER", "MKD": "SER", "BGR": "BUL", "MDA": "RUM",
    "PRT": "POR", "AND": "SPA", "GIB": "SPA",
    "MAR": "NAF", "DZA": "NAF", "SAH": "NAF", "MRT": "NAF", "TUN": "TUN", "MCO": "MAR",
    "GEO": "ARM", "ARM": "ARM", "AZE": "ARM",
    "SYR": "SYR", "LBN": "SYR", "ISR": "SYR", "PSX": "SYR", "JOR": "SYR", "IRQ": "SYR",
    "IRL": "_IRE", "ISL": "_ICE", "CYP": "_CYP", "CYN": "_CYP", "ESB": "_CYP", "WSB": "_CYP",
    "FRO": "_FRO", "EGY": "_AFR", "SAU": "_ASI", "KWT": "_ASI", "TKM": "_ASI",
    "UZB": "_ASI", "AFG": "_ASI", "PAK": "_ASI", "QAT": "_ASI", "BHR": "_ASI", "ARE": "_ASI",
    "OMN": "_ASI", "YEM": "_ASI", "TJK": "_ASI", "KGZ": "_ASI", "SDN": "_AFR", "TCD": "_AFR",
    "NER": "_AFR", "MLI": "_AFR",
}

# Countries dropped entirely (outside the board or too small to draw).
DROP_COUNTRIES = {"USA", "GRL", "MLT", "IMN", "GGY", "JEY"}

# Explicit region -> province tables, keyed by country then admin-1 `name` (or `region`).
NAME_TO_PROVINCE = {
    "DEU": {
        "Schleswig-Holstein": "KIE", "Hamburg": "KIE", "Bremen": "KIE", "Niedersachsen": "KIE",
        "Mecklenburg-Vorpommern": "BER", "Berlin": "BER", "Brandenburg": "BER", "Sachsen-Anhalt": "BER",
        "Nordrhein-Westfalen": "RUH", "Hessen": "RUH", "Rheinland-Pfalz": "RUH", "Saarland": "RUH",
        "Bayern": "MUN", "Baden-Württemberg": "MUN", "Thüringen": "MUN", "Sachsen": "MUN",
    },
    "AUT": {
        "Wien": "VIE", "Niederösterreich": "VIE", "Oberösterreich": "TYR", "Burgenland": "VIE",
        "Steiermark": "VIE", "Tirol": "TYR", "Vorarlberg": "TYR", "Salzburg": "TYR", "Kärnten": "TYR",
    },
    "RUS": {
        **{n: "STP" for n in ["City of St. Petersburg", "Leningrad", "Karelia", "Murmansk",
                              "Arkhangel'sk", "Nenets", "Novgorod", "Vologda", "Komi"]},
        "Pskov": "LVN", "Kaliningrad": "PRU",
        **{n: "UKR" for n in ["Kursk", "Belgorod", "Voronezh"]},
        **{n: "SEV" for n in ["Rostov", "Krasnodar", "Adygey", "Volgograd", "Astrakhan'", "Kalmyk",
                              "Dagestan", "Chechnya", "Ingush", "North Ossetia", "Kabardin-Balkar",
                              "Karachay-Cherkess", "Stavropol'", "Saratov", "Crimea", "Sevastopol"]},
    },
    "UKR": {
        **{n: "GAL" for n in ["L'viv", "Ivano-Frankivs'k", "Ternopil'", "Transcarpathia", "Chernivtsi"]},
        **{n: "SEV" for n in ["Odessa", "Mykolayiv", "Kherson", "Zaporizhzhya", "Donets'k", "Luhans'k"]},
    },
    "GRC": {"Kriti": "_CRE", "Anatoliki Makedonia kai Thraki": "BUL", "Notio Aigaio": "_GRI",
            "Voreio Aigaio": "_GRI", "Ionioi Nisoi": "_GRI"},
    "IRN": {n: "ARM" for n in ["West Azarbaijan", "East Azarbaijan", "Ardebil", "Gilan", "Zanjan"]},
    "KAZ": {"West Kazakhstan": "SEV", "Atyrau": "SEV", "Mangghystau": "SEV", "Aqtöbe": "MOS"},
    "LBY": {n: "TUN" for n in ["Al Jifarah", "An Nuqat al Khams", "Az Zawiyah", "Tajura' wa an Nawahi al Arba",
                               "Al Marqab", "Misratah", "Mizdah", "Ghadamis"]},
}

REGION_TO_PROVINCE = {
    "ITA": {
        "Sicily": "_SIC", "Sardegna": "_SAR", "Trentino-Alto Adige": "TYR", "Toscana": "TUS",
        "Lazio": "ROM", "Umbria": "ROM", "Apulia": "APU", "Molise": "APU", "Abruzzo": "APU",
        "Campania": "NAP", "Calabria": "NAP", "Basilicata": "NAP", "Liguria": "PIE",
        "Piemonte": "PIE", "Valle d'Aosta": "PIE", "Veneto": "VEN", "Friuli-Venezia Giulia": "VEN",
        "Emilia-Romagna": "VEN",
    },
    "GBR": {"Northern Ireland": "_IRE"},  # geonunit
    "FRA": {"Corse": "_COR"},
    "ESP": {"Islas Baleares": "_BAL", "Ceuta": "NAF", "Melilla": "NAF"},
}

# Candidate provinces per country for nearest-seed assignment.
COUNTRY_CANDIDATES = {
    "GBR": ["CLY", "EDI", "LVP", "YOR", "WAL", "LON"],
    "FRA": ["BRE", "PIC", "PAR", "BUR", "GAS", "MAR"],
    "POL": ["PRU", "WAR", "SIL", "GAL"],
    "BLR": ["WAR", "MOS", "UKR", "LVN"],
    "ROU": ["RUM", "BUD"],
    "TUR": ["CON", "ANK", "SMY", "ARM", "SYR"],
    "ITA": ["PIE", "VEN", "ROM", "APU"],  # only Lombardia and Marche fall through
    "SMR": ["VEN", "ROM", "APU"], "VAT": ["ROM"],
    "RUS": ["STP", "MOS", "SEV", "UKR"],
    "UKR": ["UKR"],
    "GRC": ["GRE"], "ESP": ["SPA"],
    "IRN": ["_ASI"], "KAZ": ["_ASI"], "LBY": ["_AFR"],
}

SEEDS = {
    # Britain
    "CLY": [(-4.25, 55.86), (-5.4, 57.3), (-6.5, 57.6), (-5.5, 56.3), (-4.6, 55.4), (-4.5, 58.3)],
    "EDI": [(-3.19, 55.95), (-2.1, 57.15), (-3.4, 56.5), (-2.8, 55.5), (-3.0, 59.0), (-1.3, 60.3), (-3.3, 57.5), (-3.9, 56.1)],
    "LVP": [(-2.98, 53.41), (-2.7, 54.5), (-2.24, 53.48), (-2.6, 53.9), (-4.0, 55.0), (-2.6, 53.2)],
    "YOR": [(-1.55, 53.8), (-1.6, 54.95), (-1.08, 53.96), (-0.35, 53.75), (-1.2, 53.0), (-2.7, 52.7), (-2.0, 52.8), (-1.5, 53.0)],
    "WAL": [(-3.8, 52.3), (-3.2, 51.55), (-4.0, 50.5), (-5.0, 50.3), (-3.1, 53.1), (-2.9, 51.1), (-2.6, 51.45), (-2.3, 51.85)],
    "LON": [(-0.13, 51.5), (1.1, 52.6), (-1.9, 52.4), (-1.2, 51.75), (-1.6, 51.9), (-1.4, 50.9), (0.1, 52.2)],
    # France
    "BRE": [(-4.49, 48.39), (-2.75, 48.0), (-1.55, 47.22), (-1.1, 49.1)],
    "PIC": [(2.3, 49.9), (1.1, 49.44), (3.06, 50.63)],
    "PAR": [(2.35, 48.86), (1.9, 47.9), (0.7, 47.4), (2.4, 47.1)],
    "BUR": [(5.04, 47.32), (6.2, 48.7), (7.75, 48.58), (6.0, 47.25), (4.83, 45.9), (4.0, 49.25)],
    "GAS": [(-0.58, 44.84), (1.44, 43.6), (0.34, 46.58), (1.26, 45.83), (3.08, 45.78)],
    "MAR": [(5.37, 43.3), (3.88, 43.61), (7.26, 43.7), (5.72, 45.19), (4.4, 44.1), (2.9, 42.7)],
    # Poland, Belarus, Romania
    "PRU": [(19.5, 54.0), (15.5, 53.8), (18.6, 54.35), (18.0, 53.1)],
    "WAR": [(21.0, 52.2), (19.5, 51.8), (22.7, 51.2), (17.0, 52.4), (23.2, 53.1), (23.7, 53.7), (23.7, 52.1), (20.6, 50.9)],
    "SIL": [(16.9, 51.1), (18.9, 50.3), (15.3, 52.0), (17.9, 50.7)],
    "GAL": [(20.0, 49.9), (22.5, 49.8)],
    "MOS": [(27.56, 53.9), (30.3, 53.9), (30.2, 55.2), (37.6, 55.75), (45.0, 55.0)],
    "UKR": [(31.0, 52.4)],
    "LVN": [(27.0, 56.5)],
    "RUM": [(26.1, 44.43), (23.8, 44.3), (27.6, 47.16), (28.65, 44.18), (26.9, 45.2)],
    "BUD": [(23.6, 46.77), (21.2, 45.75), (24.15, 45.8), (22.4, 47.2), (25.6, 45.65), (24.6, 47.2)],
    # Turkey
    "CON": [(28.98, 41.01), (26.56, 41.68), (27.5, 41.1), (26.4, 40.15), (29.06, 40.19), (29.9, 40.77), (30.4, 40.75)],
    "ANK": [(32.85, 39.93), (33.8, 41.4), (36.33, 41.29), (35.0, 40.6), (34.8, 39.8), (31.6, 40.7), (37.9, 40.9), (36.5, 39.7)],
    "ARM": [(39.72, 41.0), (41.27, 39.9), (43.4, 38.5), (38.3, 38.35), (43.1, 40.6), (39.5, 39.75)],
    "SMY": [(27.14, 38.42), (30.7, 36.9), (32.5, 37.87), (29.1, 37.8), (30.5, 38.75), (27.9, 39.65), (34.6, 37.97), (35.3, 37.0), (34.63, 36.8), (36.9, 37.6)],
    "SYR": [(36.2, 36.2), (37.38, 37.07), (38.8, 37.16), (40.2, 37.9), (41.5, 37.3)],
    # Italy (Lombardia, Marche and the microstates only)
    "PIE": [(9.19, 45.46), (9.1, 45.8), (9.9, 46.2), (8.8, 45.2)],
    "VEN": [(9.67, 45.7), (10.2, 45.54), (10.8, 45.16), (10.0, 45.13), (12.9, 43.9), (12.45, 43.94)],
    "ROM": [(12.45, 41.9)],
    "APU": [(13.6, 42.9), (13.5, 43.6)],
    # Russia remainder
    "STP": [(50.0, 66.0), (35.0, 64.0)],
    "SEV": [(45.0, 49.0)],
    # single-candidate fallbacks
    "GRE": [(22.0, 39.0)], "SPA": [(-3.7, 40.4)],
    "_ASI": [(55.0, 36.0)], "_AFR": [(25.0, 29.0)],
}

# Supply centres at their real cities (lon, lat).
SUPPLY_CENTERS = {
    "LON": (-0.13, 51.5), "EDI": (-3.19, 55.95), "LVP": (-2.98, 53.41),
    "PAR": (2.35, 48.86), "BRE": (-4.49, 48.39), "MAR": (5.37, 43.3),
    "BER": (13.4, 52.52), "MUN": (11.58, 48.14), "KIE": (10.12, 54.32),
    "ROM": (12.5, 41.9), "VEN": (12.33, 45.44), "NAP": (14.27, 40.85),
    "VIE": (16.37, 48.21), "BUD": (19.04, 47.5), "TRI": (13.77, 45.65),
    "MOS": (37.62, 55.75), "STP": (30.3, 59.94), "WAR": (21.01, 52.23), "SEV": (33.52, 44.6),
    "CON": (28.98, 41.01), "ANK": (32.85, 39.93), "SMY": (27.14, 38.42),
    "NWY": (10.75, 59.91), "SWE": (18.07, 59.33), "DEN": (12.57, 55.68), "HOL": (4.9, 52.37),
    "BEL": (4.35, 50.85), "SPA": (-3.7, 40.42), "POR": (-9.14, 38.72), "TUN": (10.18, 36.8),
    "SER": (20.46, 44.79), "RUM": (26.1, 44.43), "BUL": (23.32, 42.7), "GRE": (23.73, 37.98),
}

# ----------------------------------------------------------------- sea ----

SEA_SEEDS = {
    "NAO": [(-25.0, 55.0), (-20.0, 62.0), (-14.0, 54.0)],
    "NWG": [(0.0, 68.0), (-3.0, 65.0), (5.0, 64.5)],
    "BAR": [(40.0, 71.5), (38.0, 66.0), (30.0, 72.5)],
    "NTH": [(3.0, 56.0), (1.0, 58.5)],
    "HEL": [(7.0, 54.3)],
    "SKA": [(9.5, 57.8), (11.5, 57.0)],
    "BAL": [(18.0, 56.0), (20.0, 58.0), (14.0, 54.8)],
    "BOT": [(20.0, 62.0), (26.0, 59.8), (23.0, 64.5)],
    "ENG": [(-2.0, 50.2)],
    "IRI": [(-5.0, 53.0), (-7.0, 51.2)],
    "MAO": [(-15.0, 42.0), (-8.0, 45.5)],
    "WES": [(4.0, 38.5)],
    "LYO": [(5.0, 42.5)],
    "TYS": [(12.0, 40.0)],
    "ION": [(18.0, 37.0)],
    "ADR": [(15.5, 43.0)],
    "AEG": [(25.0, 38.5)],
    "EAS": [(31.0, 34.5)],
    "BLA": [(34.0, 43.5)],
}

# Water that is drawn but belongs to no zone.
LAKE_SEEDS = [(28.0, 40.75), (50.0, 42.0)]  # Sea of Marmara, Caspian

# Straight boundaries between sea zones (lon, lat). Endpoints sit a little inland so
# every line crosses the water completely.
SEA_BOUNDARIES = [
    # North Atlantic / Norwegian Sea, and the North Channel
    [(-10.0, 80.0), (-4.9, 58.4)],
    [(-6.2, 55.15), (-4.95, 54.75)],
    # North Atlantic / Mid-Atlantic, Irish Sea / Mid-Atlantic, Irish Sea / English Channel
    [(-60.0, 47.5), (-9.9, 51.65)],
    [(-9.9, 51.65), (-6.3, 49.4), (-4.6, 48.45)],
    [(-6.3, 49.4), (-5.55, 50.12)],
    # North Sea / Norwegian Sea, North Sea / English Channel
    [(-3.9, 57.5), (5.4, 61.9)],
    [(1.35, 51.3), (2.95, 51.25)],
    # Helgoland Bight, Skagerrak, the Danish straits
    [(4.8, 52.95), (7.3, 55.4), (8.3, 55.55)],
    [(7.1, 58.1), (8.7, 57.05)],
    [(12.45, 56.0), (12.95, 56.1)],
    [(10.4, 55.35), (11.4, 55.45)],
    [(9.7, 55.6), (10.0, 55.45)],
    # Baltic / Gulf of Bothnia
    [(18.3, 59.6), (20.0, 59.95), (23.0, 59.75), (23.6, 59.1)],
    # Norwegian Sea / Barents Sea
    [(20.0, 80.0), (25.6, 70.95)],
    # Gibraltar
    [(-5.62, 36.2), (-5.35, 35.75)],
    # Western Med / Gulf of Lyon, Gulf of Lyon / Tyrrhenian, Bonifacio, Western Med / Tyrrhenian
    [(3.15, 42.05), (8.25, 40.65)],
    [(9.35, 43.0), (10.55, 42.95)],
    [(9.25, 41.45), (9.2, 41.2)],
    [(8.85, 39.3), (9.85, 37.3)],
    # Tyrrhenian / Ionian: Messina and the Sicilian channel
    [(15.4, 38.1), (15.9, 38.3)],
    [(12.45, 37.85), (11.0, 37.05)],
    # Ionian / Adriatic
    [(18.45, 40.2), (19.45, 40.45)],
    # Ionian / Aegean, Aegean / Eastern Med, Ionian / Eastern Med
    [(23.15, 36.5), (23.65, 35.5)],
    [(26.25, 35.2), (27.9, 36.2), (28.6, 37.0)],
    [(24.8, 35.0), (25.0, 31.5)],
    # Bosporus and Dardanelles close the Sea of Marmara
    [(28.8, 41.12), (29.4, 41.12)],
    [(26.45, 40.3), (26.4, 40.0)],
]

# Named coasts: which sea zone each coast faces (the anchor sits on that shoreline).
COAST_FACING = {
    "STP": {"NC": "BAR", "SC": "BOT"},
    "SPA": {"NC": "MAO", "SC": "WES"},
    "BUL": {"EC": "BLA", "SC": "AEG"},
}

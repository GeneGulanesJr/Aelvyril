"""
Self-contained synthetic PII data generators using only Python stdlib.

Replaces faker dependency for benchmark pipeline validation.
Produces structurally valid but fake data for all supported entity types.
"""

from __future__ import annotations

import random
import string
from datetime import datetime, timedelta
from typing import List, Tuple


# ── Names ──────────────────────────────────────────────────────────────────────

FIRST_NAMES = [
    "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
    "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph",
    "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Christopher", "Nancy",
    "Daniel", "Lisa", "Matthew", "Betty", "Anthony", "Margaret", "Mark", "Sandra",
    "Donald", "Ashley", "Steven", "Kimberly", "Paul", "Emily", "Andrew", "Donna",
    "Joshua", "Michelle", "Kenneth", "Dorothy", "Kevin", "Carol", "Brian", "Amanda",
    "George", "Melissa", "Timothy", "Deborah", "Ronald", "Stephanie", "Edward",
    "Rebecca", "Jason", "Sharon", "Jeffrey", "Laura", "Ryan", "Cynthia", "Jacob",
    "Kathleen", "Gary", "Amy", "Nicholas", "Angela", "Eric", "Shirley", "Jonathan",
    "Anna", "Stephen", "Brenda", "Larry", "Pamela", "Justin", "Emma", "Scott",
    "Nicole", "Brandon", "Helen", "Benjamin", "Samantha", "Samuel", "Katherine",
    "Gregory", "Christine", "Alexander", "Debra", "Frank", "Rachel", "Patrick",
    "Catherine", "Raymond", "Carolyn", "Jack", "Janet", "Dennis", "Ruth",
    "Wei", "Li", "Hui", "Jie", "Fang", "Min", "Ling", "Yan", "Hua", "Tao",
    "Maria", "Jose", "Antonio", "Carmen", "Ana", "Juan", "Francisco", "Isabel",
    "Hans", "Anna", "Peter", "Ursula", "Wolfgang", "Monika", "Klaus", "Brigitte",
    "Hiroshi", "Yuki", "Takeshi", "Sakura", "Kenji", "Naoko", "Satoshi", "Akiko",
    "Raj", "Priya", "Amit", "Sunita", "Vikram", "Deepa", "Sanjay", "Anita",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
    "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
    "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
    "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen",
    "Hill", "Flores", "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera",
    "Campbell", "Mitchell", "Carter", "Roberts", "Gomez", "Phillips", "Evans",
    "Turner", "Diaz", "Parker", "Cruz", "Edwards", "Collins", "Reyes", "Stewart",
    "Morris", "Morales", "Murphy", "Cook", "Rogers", "Gutierrez", "Ortiz",
    "Morgan", "Cooper", "Peterson", "Bailey", "Reed", "Kelly", "Howard", "Ramos",
    "Kim", "Cox", "Ward", "Richardson", "Watson", "Brooks", "Chavez", "Wood",
    "James", "Bennett", "Gray", "Mendoza", "Ruiz", "Hughes", "Price", "Alvarez",
    "Castillo", "Sanders", "Patel", "Myers", "Long", "Ross", "Foster", "Jimenez",
    "Wang", "Li", "Zhang", "Liu", "Chen", "Yang", "Huang", "Zhao", "Wu", "Zhou",
    "Xu", "Sun", "Ma", "Zhu", "Hu", "Guo", "He", "Gao", "Lin", "Luo",
    "Singh", "Kumar", "Sharma", "Gupta", "Shah", "Patel", "Reddy", "Nair",
    "Ivanov", "Smirnov", "Kuznetsov", "Popov", "Sokolov", "Lebedev", "Kozlov",
]

COMPANY_SUFFIXES = [
    "Corp", "Inc", "Ltd", "LLC", "Group", "Holdings", "Partners", "Associates",
    "Systems", "Technologies", "Solutions", "Enterprises", "Industries", "Global",
    "International", "Network", "Media", "Digital", "Dynamics", "Innovations",
]

COMPANY_PREFIXES = [
    "Acme", "Apex", "Atlas", "Bright", "Catalyst", "Cipher", "Cobalt", "Core",
    "Data", "Echo", "Edge", "Flux", "Genesis", "Global", "Horizon", "Ignite",
    "Infinity", "Iron", "Kinetic", "Lunar", "Meridian", "Meta", "Nexus", "Nova",
    "Omega", "Orbit", "Prime", "Quantum", "Rapid", "Solar", "Spark", "Stratum",
    "Synapse", "Terra", "Vector", "Vertex", "Vista", "Zenith",
]

CITIES = [
    "New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia",
    "San Antonio", "San Diego", "Dallas", "San Jose", "Austin", "Jacksonville",
    "Fort Worth", "Columbus", "Charlotte", "San Francisco", "Indianapolis",
    "Seattle", "Denver", "Washington", "Boston", "El Paso", "Nashville",
    "Detroit", "Oklahoma City", "Portland", "Las Vegas", "Louisville", "Baltimore",
    "Milwaukee", "Albuquerque", "Tucson", "Fresno", "Sacramento", "Mesa",
    "Kansas City", "Atlanta", "Long Beach", "Colorado Springs", "Raleigh",
    "Omaha", "Miami", "Oakland", "Minneapolis", "Tulsa", "Cleveland", "Wichita",
    "Arlington", "New Orleans", "Bakersfield", "Tampa", "Honolulu", "Aurora",
    "Anaheim", "Santa Ana", "Corpus Christi", "Riverside", "Lexington", "Stockton",
    "Henderson", "Saint Paul", "St. Louis", "Cincinnati", "Pittsburgh", "Greensboro",
    "Anchorage", "Plano", "Lincoln", "Orlando", "Irvine", "Newark", "Durham",
    "Chula Vista", "Toledo", "Fort Wayne", "St. Petersburg", "Laredo", "Jersey City",
    "Chandler", "Madison", "Lubbock", "Scottsdale", "Reno", "Buffalo", "Gilbert",
    "Glendale", "North Las Vegas", "Winston-Salem", "Chesapeake", "Norfolk",
    "Fremont", "Garland", "Irving", "Hialeah", "Richmond", "Boise", "Spokane",
    "Baton Rouge", "Des Moines", "Tacoma", "San Bernardino", "Modesto", "Fontana",
    "Santa Clarita", "Birmingham", "Oxnard", "Fayetteville", "Moreno Valley",
    "Rochester", "Glendale", "Huntington Beach", "Salt Lake City", "Grand Rapids",
    "Amarillo", "Yonkers", "Aurora", "Montgomery", "Akron", "Little Rock",
    "Huntsville", "Augusta", "Port St. Lucie", "Grand Prairie", "Columbus",
    "Tallahassee", "Overland Park", "Tempe", "McKinney", "Mobile", "Cape Coral",
    "Shreveport", "Frisco", "Knoxville", "Worcester", "Brownsville", "Vancouver",
    "Fort Lauderdale", "Sioux Falls", "Ontario", "Chattanooga", "Providence",
    "Newport News", "Rancho Cucamonga", "Santa Rosa", "Oceanside", "Salem",
    "Elk Grove", "Garden Grove", "Pembroke Pines", "Peoria", "Eugene", "Corona",
    "Cary", "Springfield", "Fort Collins", "Jackson", "Alexandria", "Hayward",
    "Lancaster", "Lakewood", "Clarksville", "Palmdale", "Salinas", "Springfield",
    "Hollywood", "Pasadena", "Sunnyvale", "Macon", "Pomona", "Escondido",
    "Killeen", "Naperville", "Joliet", "Bellevue", "Rockford", "Savannah",
    "Paterson", "Torrance", "Lakes", "Bridgeport", "Bayamon", "Olathe",
    "London", "Paris", "Berlin", "Madrid", "Rome", "Vienna", "Amsterdam",
    "Brussels", "Zurich", "Stockholm", "Copenhagen", "Oslo", "Helsinki",
    "Warsaw", "Prague", "Budapest", "Dublin", "Lisbon", "Athens", "Istanbul",
    "Tokyo", "Osaka", "Kyoto", "Seoul", "Beijing", "Shanghai", "Singapore",
    "Bangkok", "Mumbai", "Delhi", "Sydney", "Melbourne", "Toronto", "Vancouver",
    "Montreal", "Mexico City", "Sao Paulo", "Buenos Aires", "Cairo", "Dubai",
    "Moscow", "Saint Petersburg", "Kiev", "Warsaw", "Bucharest", "Belgrade",
    "Zagreb", "Sofia", "Tallinn", "Riga", "Vilnius", "Bratislava", "Ljubljana",
]

COUNTRIES = [
    "United States", "China", "Japan", "Germany", "United Kingdom", "France",
    "India", "Italy", "Brazil", "Canada", "Russia", "South Korea", "Spain",
    "Australia", "Mexico", "Indonesia", "Netherlands", "Saudi Arabia", "Turkey",
    "Switzerland", "Poland", "Belgium", "Sweden", "Argentina", "Thailand",
    "Austria", "Norway", "United Arab Emirates", "Israel", "Ireland", "Nigeria",
    "South Africa", "Denmark", "Singapore", "Malaysia", "Hong Kong", "Philippines",
    "Pakistan", "Egypt", "Bangladesh", "Vietnam", "Chile", "Finland", "Colombia",
    "Romania", "Czech Republic", "Portugal", "New Zealand", "Greece", "Iraq",
    "Algeria", "Qatar", "Kazakhstan", "Hungary", "Kuwait", "Morocco", "Peru",
    "Ukraine", "Slovakia", "Ecuador", "Puerto Rico", "Luxembourg", "Dominican Republic",
    "Guatemala", "Kenya", "Ethiopia", "Uzbekistan", "Myanmar", "Angola", "Croatia",
    "Panama", "Lithuania", "Sri Lanka", "Costa Rica", "Serbia", "Bulgaria",
    "Ghana", "Macao", "Jordan", "Tanzania", "Belarus", "Uruguay", "Paraguay",
    "Lebanon", "Bolivia", "Tunisia", "Nepal", "Libya", "Cameroon", "Latvia",
    "Estonia", "Uganda", "Yemen", "Zambia", "Honduras", "Cyprus", "El Salvador",
    "Senegal", "Iceland", "Papua New Guinea", "Cambodia", "Zimbabwe", "Bosnia",
    "Trinidad", "Georgia", "Sudan", "Laos", "Guinea", "Armenia", "Albania",
    "Burkina Faso", "Mali", "Mozambique", "Malta", "Mongolia", "Jamaica",
    "Namibia", "Madagascar", "Chad", "Nicaragua", "Mauritius", "Bahamas",
    "North Macedonia", "Brunei", "Rwanda", "Equatorial Guinea", "Kosovo",
    "Tajikistan", "Kyrgyzstan", "Togo", "Benin", "Malawi", "Niger", "Moldova",
    "Liechtenstein", "Montenegro", "Suriname", "Congo", "Fiji", "Barbados",
    "Guyana", "Eswatini", "Djibouti", "Liberia", "Andorra", "Maldives",
    "Burundi", "Lesotho", "Central African Republic", "Belize", "Cabo Verde",
    "Gambia", "Saint Lucia", "Antigua", "Seychelles", "San Marino", "Solomon Islands",
    "Guinea-Bissau", "Comoros", "Grenada", "Saint Kitts", "Vanuatu", "Samoa",
    "Saint Vincent", "Micronesia", "Tonga", "Kiribati", "Palau", "Marshall Islands",
    "Tuvalu", "Nauru",
]

STREET_SUFFIXES = ["St", "Ave", "Blvd", "Rd", "Dr", "Ln", "Way", "Ct", "Pl", "Ter"]

EMAIL_DOMAINS = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "protonmail.com", "aol.com", "mail.com", "yandex.com", "qq.com",
    "163.com", "126.com", "sina.com", "sohu.com", "foxmail.com",
    "live.com", "msn.com", "corp.com", "enterprise.net", "company.org",
]

ORG_TYPES = [
    "University", "Institute", "Laboratory", "Center", "Foundation",
    "Association", "Society", "Council", "Academy", "College",
    "Hospital", "Clinic", "Bank", "Trust", "Fund", "Capital",
    "Ventures", "Advisors", "Consulting", "Legal", "Services",
]

ORG_TOPICS = [
    "Medical", "Health", "Science", "Technology", "Research", "Education",
    "Environmental", "Energy", "Financial", "Investment", "Commercial",
    "Industrial", "Manufacturing", "Construction", "Transportation",
    "Communications", "Media", "Entertainment", "Sports", "Arts",
    "Cultural", "Humanitarian", "Development", "Policy", "Strategic",
    "Global", "International", "National", "Regional", "Local",
    "Public", "Private", "Federal", "State", "Municipal",
]

UNIVERSITIES = [
    "Harvard University", "Stanford University", "MIT", "University of Cambridge",
    "University of Oxford", "Caltech", "Princeton University", "Yale University",
    "Columbia University", "University of Chicago", "Imperial College London",
    "University College London", "University of Pennsylvania", "ETH Zurich",
    "Cornell University", "University of Tokyo", "Peking University",
    "Tsinghua University", "University of Toronto", "Johns Hopkins University",
    "University of Michigan", "Northwestern University", "Duke University",
    "University of Edinburgh", "University of Melbourne", "National University of Singapore",
    "University of Hong Kong", "Seoul National University", "Kyoto University",
    "Fudan University", "Zhejiang University", "Shanghai Jiao Tong University",
    "Nanjing University", "University of Science and Technology of China",
    "Sun Yat-sen University", "Wuhan University", "Huazhong University of Science and Technology",
    "Xi'an Jiaotong University", "Harbin Institute of Technology", "Beihang University",
    "Tongji University", "Beijing Normal University", "Nankai University",
    "Tianjin University", "Southeast University", "Sichuan University",
    "University of California, Berkeley", "University of California, Los Angeles",
    "University of California, San Diego", "University of California, San Francisco",
    "University of Washington", "University of Wisconsin-Madison",
    "University of Illinois at Urbana-Champaign", "University of Texas at Austin",
    "University of North Carolina at Chapel Hill", "University of Minnesota",
    "University of Florida", "University of Pittsburgh", "University of Rochester",
    "University of Maryland", "University of Virginia", "University of Notre Dame",
    "University of California, Davis", "University of California, Irvine",
    "University of California, Santa Barbara", "University of Colorado Boulder",
    "University of Arizona", "University of Utah", "University of Oregon",
    "University of Iowa", "University of Kansas", "University of Nebraska",
    "University of Missouri", "University of Oklahoma", "University of Arkansas",
    "University of New Mexico", "University of Hawaii", "University of Alaska",
    "University of Vermont", "University of New Hampshire", "University of Maine",
    "University of Rhode Island", "University of Connecticut", "University of Massachusetts",
    "University of Delaware", "University of West Virginia", "University of Kentucky",
    "University of Tennessee", "University of Alabama", "University of Mississippi",
    "University of Georgia", "University of South Carolina", "University of Louisiana",
]


def _random_name(rng: random.Random) -> str:
    return f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"


def _random_email(rng: random.Random, name: str | None = None) -> str:
    if name is None:
        name = _random_name(rng)
    user = name.lower().replace(" ", ".").replace("'", "") + str(rng.randint(1, 999))
    domain = rng.choice(EMAIL_DOMAINS)
    return f"{user}@{domain}"


def _random_phone(rng: random.Random) -> str:
    fmt = rng.choice([
        lambda: f"({rng.randint(200, 999)}) {rng.randint(200, 999)}-{rng.randint(1000, 9999)}",
        lambda: f"{rng.randint(200, 999)}-{rng.randint(200, 999)}-{rng.randint(1000, 9999)}",
        lambda: f"+1-{rng.randint(200, 999)}-{rng.randint(200, 999)}-{rng.randint(1000, 9999)}",
        lambda: f"1-{rng.randint(200, 999)}-{rng.randint(200, 999)}-{rng.randint(1000, 9999)}",
        lambda: f"{rng.randint(200, 999)}.{rng.randint(200, 999)}.{rng.randint(1000, 9999)}",
    ])
    return fmt()


def _random_ssn(rng: random.Random) -> str:
    return f"{rng.randint(100, 999)}-{rng.randint(10, 99)}-{rng.randint(1000, 9999)}"


def _random_credit_card(rng: random.Random) -> str:
    # Generate a 16-digit number that passes the Luhn checksum.
    prefixes = ["4", "5"]
    prefix = rng.choice(prefixes)
    # Generate 15 random digits + 1 check digit
    digits = [int(d) for d in prefix] + [rng.randint(0, 9) for _ in range(14)]
    # Compute Luhn check digit
    def luhn_check_digit(nums: list[int]) -> int:
        total = 0
        # Double every second digit from the right (excluding check digit position)
        for i in range(len(nums) - 1, -1, -1):
            d = nums[i]
            if (len(nums) - i) % 2 == 0:
                d = d * 2
                if d > 9:
                    d -= 9
            total += d
        return (10 - (total % 10)) % 10
    check = luhn_check_digit(digits)
    digits.append(check)
    # Format with spaces every 4 digits
    s = "".join(str(d) for d in digits)
    return " ".join(s[i:i+4] for i in range(0, 16, 4))


def _random_iban(rng: random.Random) -> str:
    # Correct BBAN lengths per ISO 13616 (total = 4 + bban_len)
    _BBAN_LENGTH = {
        "GB": 18,  # 22 total
        "DE": 18,  # 22
        "FR": 23,  # 27
        "ES": 20,  # 24
        "IT": 23,  # 27
        "NL": 14,  # 18
        "BE": 12,  # 16
        "AT": 16,  # 20
        "CH": 17,  # 21
        "PL": 24,  # 28
    }
    country = rng.choice(["GB", "DE", "FR", "ES", "IT", "NL", "BE", "AT", "CH", "PL"])
    bban_len = _BBAN_LENGTH[country]
    bban = "".join(str(rng.randint(0, 9)) for _ in range(bban_len))

    # Compute correct check digits per IBAN spec:
    # 1. Form string: country + "00" + bban (00 = placeholder check digits)
    # 2. Move first 4 characters to the end
    # 3. Replace letters with numbers (A=10, B=11, ..., Z=35)
    # 4. Mod 97, then check digits = 98 - mod
    base = country + "00" + bban
    rearranged = base[4:] + base[:4]
    num_str = "".join(str(ord(c) - 55) if c.isalpha() else c for c in rearranged)
    check_digits = 98 - (int(num_str) % 97)
    return f"{country}{check_digits:02d}{bban}"


def _random_ip(rng: random.Random) -> str:
    return f"{rng.randint(1, 255)}.{rng.randint(0, 255)}.{rng.randint(0, 255)}.{rng.randint(0, 255)}"


def _random_date(rng: random.Random) -> str:
    start = datetime(1950, 1, 1)
    delta = timedelta(days=rng.randint(0, 27000))
    d = start + delta
    fmt = rng.choice([
        "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%B %d, %Y",
        "%b %d, %Y", "%Y/%m/%d", "%d-%m-%Y", "%m-%d-%Y",
    ])
    return d.strftime(fmt)


def _random_date_time(rng: random.Random) -> str:
    d = _random_date(rng)
    t = f"{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}"
    return f"{d} {t}"


def _random_city(rng: random.Random) -> str:
    return rng.choice(CITIES)


def _random_country(rng: random.Random) -> str:
    return rng.choice(COUNTRIES)


def _random_address(rng: random.Random) -> str:
    num = rng.randint(1, 9999)
    street = rng.choice(LAST_NAMES)
    suffix = rng.choice(STREET_SUFFIXES)
    city = rng.choice(CITIES)
    state = rng.choice(LAST_NAMES)
    zipcode = f"{rng.randint(10000, 99999)}"
    return f"{num} {street} {suffix}, {city}, {state} {zipcode}"


def _random_company(rng: random.Random) -> str:
    return f"{rng.choice(COMPANY_PREFIXES)} {rng.choice(COMPANY_SUFFIXES)}"


def _random_org(rng: random.Random) -> str:
    return rng.choice([
        lambda: f"{rng.choice(COMPANY_PREFIXES)} {rng.choice(ORG_TYPES)}",
        lambda: f"{rng.choice(ORG_TOPICS)} {rng.choice(ORG_TYPES)}",
        lambda: rng.choice(UNIVERSITIES),
        lambda: _random_company(rng),
    ])()


def _random_url(rng: random.Random) -> str:
    tld = rng.choice(["com", "org", "net", "edu", "gov", "io", "co", "ai", "dev"])
    name = rng.choice(COMPANY_PREFIXES).lower()
    path = rng.choice(["", "/about", "/contact", "/products", "/services", "/blog"])
    return f"https://www.{name}.{tld}{path}"


def _random_domain(rng: random.Random) -> str:
    tld = rng.choice(["com", "org", "net", "edu", "gov", "io", "co"])
    return f"{rng.choice(COMPANY_PREFIXES).lower()}.{tld}"


def _random_api_key(rng: random.Random) -> str:
    prefixes = ["sk", "ak", "pk", "api", "key", "token", "bearer"]
    prefix = rng.choice(prefixes)
    chars = string.ascii_letters + string.digits
    key = "".join(rng.choice(chars) for _ in range(rng.randint(24, 48)))
    return f"{prefix}_{key}"


def _random_password(rng: random.Random) -> str:
    chars = string.ascii_letters + string.digits + "!@#$%^&*"
    return "".join(rng.choice(chars) for _ in range(rng.randint(10, 20)))


def _random_nrp(rng: random.Random) -> str:
    # Nationality / Religious / Political
    return rng.choice([
        "American", "British", "Canadian", "Australian", "German", "French",
        "Japanese", "Chinese", "Indian", "Brazilian", "Mexican", "Italian",
        "Spanish", "Russian", "Korean", "Dutch", "Swedish", "Norwegian",
        "Christian", "Muslim", "Jewish", "Hindu", "Buddhist", "Sikh",
        "Democrat", "Republican", "Liberal", "Conservative", "Socialist",
        "Labor", "Green", "Independent", "Libertarian", "Progressive",
    ])


def _random_username(rng: random.Random) -> str:
    return f"{rng.choice(FIRST_NAMES).lower()}{rng.randint(1, 9999)}"


def _random_uuid(rng: random.Random) -> str:
    parts = [
        "".join(str(rng.choice(string.hexdigits.lower())) for _ in range(8)),
        "".join(str(rng.choice(string.hexdigits.lower())) for _ in range(4)),
        "".join(str(rng.choice(string.hexdigits.lower())) for _ in range(4)),
        "".join(str(rng.choice(string.hexdigits.lower())) for _ in range(4)),
        "".join(str(rng.choice(string.hexdigits.lower())) for _ in range(12)),
    ]
    return "-".join(parts)


def _random_title(rng: random.Random) -> str:
    return rng.choice([
        "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sir", "Lady", "Lord",
        "Capt.", "Col.", "Gen.", "Rev.", "Hon.", "Mx.", "Miss",
    ])


def _random_zipcode(rng: random.Random) -> str:
    return f"{rng.randint(10000, 99999)}"


# ── Unified generator ──────────────────────────────────────────────────────────

ENTITY_GENERATORS = {
    "PERSON": _random_name,
    "LOCATION": _random_city,
    "GPE": _random_city,
    "ORGANIZATION": _random_org,
    "ORG": _random_org,
    "EMAIL": _random_email,
    "PHONE": _random_phone,
    "SSN": _random_ssn,
    "CREDIT_CARD": _random_credit_card,
    "IBAN": _random_iban,
    "IP_ADDRESS": _random_ip,
    "IP": _random_ip,
    "DATE": _random_date,
    "DATETIME": _random_date_time,
    "URL": _random_url,
    "DOMAIN": _random_domain,
    "USERNAME": _random_username,
    "PASSWORD": _random_password,
    "API_KEY": _random_api_key,
    "UUID": _random_uuid,
    "NRP": _random_nrp,
    "TITLE": _random_title,
    "ZIP_CODE": _random_zipcode,
    "ADDRESS": _random_address,
    "COUNTRY": _random_country,
    "COMPANY": _random_company,
}


def generate_entity(entity_type: str, rng: random.Random | None = None) -> str:
    """Generate a single synthetic entity value of the given type."""
    if rng is None:
        rng = random.Random()
    gen = ENTITY_GENERATORS.get(entity_type, _random_name)
    return gen(rng)


def generate_entity_with_position(
    entity_type: str,
    rng: random.Random,
    prefix: str = "",
    suffix: str = "",
) -> Tuple[str, int, int]:
    """Generate an entity surrounded by prefix/suffix, returning (full_text, start, end)."""
    value = generate_entity(entity_type, rng)
    full = f"{prefix}{value}{suffix}"
    start = len(prefix)
    end = start + len(value)
    return full, start, end

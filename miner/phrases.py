"""Problem ids and names, both from a hash of the problem's game link + FEN, so the same
problem gets the same id and name in every run, whatever else is mined.

  id:   10 base32 chars (50 bits); the key everything uses. The export stops on a clash
        (1,100 problems: ~5e-10 chance).
  name: adjective-color-bird (e.g. "nimble-amber-heron"), a label to remember. ~6.5M names,
        so two problems may share one; they still have different ids.

Changing the word lists renames every problem: don't edit them.
"""
import hashlib

ADJECTIVES = """
able agile airy alert ancient angular ardent artful astute august awake balmy bashful bold
bouncy brave breezy bright brisk bubbly busy calm candid careful casual cheeky cheerful chilly
chipper civil clean clever cloudy clumsy cosmic cozy crafty crisp curious curly dainty dapper
daring dashing dazzling deft dizzy dreamy dusty eager early earnest easy elated elegant epic
exact fabled fair faithful fancy fearless feisty fierce fine firm fleet fluffy fond formal
frank free fresh friendly frosty frugal funny fuzzy gallant gentle giant giddy glad gleeful
glossy graceful grand grateful grumpy happy hardy hasty hearty heroic hidden honest hopeful
humble hungry icy ideal idle jaunty jolly jovial joyful jumpy keen kind kingly knotty lanky
large late lazy lean level light limber little lively lofty loud loyal lucid lucky lunar lush
magic majestic mellow merry mighty mild misty modest moody mossy muddy musical mystic narrow
neat nifty nimble noble noisy nomadic odd oaken open orderly patient peaceful peppy perky
placid playful plucky plush polite polar proud prudent quaint quick quiet quirky radiant rapid
rare ready regal restless rich rigid robust rocky royal rugged rustic sandy savvy secret
serene shady sharp shiny shy silent silky simple sleepy slender slick sly smart smooth snappy
snowy snug soft solar solemn solid sound spare sparkly speedy spicy spry stable stark starry
steady stealthy stern still stoic stormy stout sturdy subtle sunny supple sure tall tame
tender tidy timid tiny tough tranquil tricky trusty twinkly upbeat urban valiant vast velvet
vivid wandering warm wary watchful wavy wealthy wild windy wise witty wobbly woolly worthy
young zany zealous zesty
""".split()

COLORS = """
amber aqua ash auburn azure beige black blue blush bone brass brick bronze brown buff burgundy
carmine celadon cerise cerulean charcoal cherry chestnut citrine claret cobalt cocoa copper
coral cream crimson cyan denim ebony emerald fawn fern flax ginger gold gray green hazel honey
indigo ivory jade jet khaki lapis lavender lemon lilac lime linen magenta mahogany maroon mauve
mint mocha moss mustard navy ochre olive onyx opal orange peach pearl pewter pine pink plum
poppy purple red rose ruby russet rust sable saffron sage salmon sand sapphire scarlet sepia
sienna silver sky slate smoke snow steel straw tan taupe tawny thistle topaz turquoise umber
vermilion violet wheat white yellow
""".split()

BIRDS = """
albatross auk avocet bittern blackbird bluebird bobolink booby bowerbird brambling bulbul
bunting bustard buzzard canary capercaillie caracara cardinal cassowary catbird chaffinch
chickadee chiffchaff chough chukar cockatoo condor coot cormorant corncrake cowbird crake crane
crossbill crow cuckoo curassow curlew dipper dodo dotterel dove dowitcher drongo duck dunlin
dunnock eagle egret eider emu falcon fieldfare finch flamingo flicker flycatcher frigatebird
fulmar gadwall gallinule gannet garganey godwit goldcrest goldfinch goose goshawk grackle grebe
greenfinch grosbeak grouse guillemot gull harrier hawfinch hawk heron hoatzin hobby honeyeater
hoopoe hornbill hummingbird ibis jacana jackdaw jay junco kakapo kea kestrel killdeer kingbird
kingfisher kinglet kite kittiwake kiwi knot kookaburra lapwing lark limpkin linnet loon
lorikeet lory lyrebird macaw magpie mallard manakin martin meadowlark merganser merlin
mockingbird moorhen motmot murrelet myna nighthawk nightingale nightjar nuthatch oriole osprey
ostrich ouzel ovenbird owl oystercatcher parakeet parrot partridge pelican penguin petrel
phalarope pheasant phoebe pigeon pintail pipit plover pochard ptarmigan puffin quail quetzal
rail raven razorbill redpoll redshank redstart redwing rhea roadrunner robin rook rosella ruff
sanderling sandpiper sapsucker scaup scoter seriema shag shearwater shoebill shrike siskin
skimmer skua skylark smew snipe sparrow spoonbill starling stilt stint stonechat stork sunbird
swallow swan swift tanager tattler teal tern thrasher thrush tinamou tit titmouse toucan towhee
treecreeper trogon turaco turkey turnstone veery vireo vulture wagtail warbler waxwing weaver
wheatear whimbrel whinchat whipbird whydah wigeon willet woodcock woodpecker wren wrybill
yellowhammer yellowlegs
""".split()

for _name, _words in (("ADJECTIVES", ADJECTIVES), ("COLORS", COLORS), ("BIRDS", BIRDS)):
    assert len(set(_words)) == len(_words), f"{_name} has a duplicate"
assert not (set(ADJECTIVES) & set(COLORS) or set(ADJECTIVES) & set(BIRDS) or set(COLORS) & set(BIRDS))

SPACE = len(ADJECTIVES) * len(COLORS) * len(BIRDS)


ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"  # Crockford base32: no i, l, o, u


def _hash(link, fen):
    return int.from_bytes(hashlib.sha1(f"{link}#{fen}".encode()).digest()[:8], "big")


def problem_id(link, fen, n=10):
    h = _hash(link, fen)
    return "".join(ID_ALPHABET[(h >> (5 * k)) & 31] for k in range(n))


def problem_name(link, fen):
    h, a = divmod(_hash(link, fen), len(ADJECTIVES))
    h, c = divmod(h, len(COLORS))
    return f"{ADJECTIVES[a]}-{COLORS[c]}-{BIRDS[h % len(BIRDS)]}"

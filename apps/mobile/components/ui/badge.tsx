import { TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import * as Slot from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Platform, View } from 'react-native';

const badgeVariants = cva(
  cn(
    'group shrink-0 flex-row items-center justify-center gap-1 overflow-hidden rounded-full border border-border px-2 py-0.5',
    Platform.select({
      web: 'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive w-fit whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3',
    })
  ),
  {
    variants: {
      variant: {
        default: cn(
          'border-transparent bg-primary',
          Platform.select({ web: '[a&]:hover:bg-primary/90' })
        ),
        secondary: cn(
          'border-transparent bg-secondary',
          Platform.select({ web: '[a&]:hover:bg-secondary/90' })
        ),
        destructive: cn(
          'border-transparent bg-destructive',
          Platform.select({ web: '[a&]:hover:bg-destructive/90' })
        ),
        outline: Platform.select({ web: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground' }),
        oliveGreen: cn('bg-cosmos-rosePink border-transparent'),
        rosePink: cn('bg-cosmos-rosePink/30 border-transparent'),
        success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
        badgeSuccess:
          'disabled:border-alpha-300 outline-hidden has-focus-visible:ring-2 pointer-events-none inline-flex h-6 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full border-transparent bg-emerald-200 bg-teal-100 px-1.5 text-[11px] font-medium text-emerald-800 text-teal-700 ring-blue-600 transition-all hover:bg-teal-100 focus:bg-teal-100 focus-visible:bg-teal-100 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 disabled:ring-0 has-[>svg]:pl-[10px] dark:bg-emerald-900/50 dark:text-emerald-500 [&>svg]:pointer-events-none [&>svg]:size-3',
        update: 'bg-chart-2/25 text-chart-2 border border-transparent',
        warning:
          'border border-transparent bg-yellow-200 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-500',
        info: 'border border-transparent bg-neutral-200 text-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-500',
        terminal:
          'border border-transparent bg-purple-200 text-purple-800 dark:bg-purple-900/50 dark:text-purple-500',
        reset:
          'border border-transparent bg-amber-200 text-amber-800 dark:bg-amber-900/50 dark:text-amber-500',
        opened: 'flex-shrink-0 border bg-accent text-muted-foreground',
        closed: 'flex-shrink-0 border bg-accent text-muted-foreground',
        blue: 'bg-chart-2 flex-shrink-0 border text-background',
        loading:
          'border-transparent bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',

        red: 'border-transparent bg-red-200 text-red-800 dark:bg-red-900/50 dark:text-red-300',
        orange:
          'border-transparent bg-orange-200 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300',
        amber:
          'border-transparent bg-amber-200 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
        yellow:
          'border-transparent bg-yellow-200 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300',
        lime: 'border-transparent bg-lime-200 text-lime-800 dark:bg-lime-900/50 dark:text-lime-300',
        green:
          'border-transparent bg-green-200 text-green-800 dark:bg-green-900/50 dark:text-green-300',
        emerald:
          'border-transparent bg-emerald-200 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
        teal: 'border-transparent bg-teal-200 text-teal-800 dark:bg-teal-900/50 dark:text-teal-300',
        cyan: 'border-transparent bg-cyan-200 text-cyan-800 dark:bg-cyan-900/50 dark:text-cyan-300',
        sky: 'border-transparent bg-sky-200 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300',
        indigo:
          'border-transparent bg-indigo-200 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300',
        violet:
          'border-transparent bg-violet-200 text-violet-800 dark:bg-violet-900/50 dark:text-violet-300',
        purple:
          'border-transparent bg-purple-200 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300',
        fuchsia:
          'border-transparent bg-fuchsia-200 text-fuchsia-800 dark:bg-fuchsia-900/50 dark:text-fuchsia-300',
        pink: 'border-transparent bg-pink-200 text-pink-800 dark:bg-pink-900/50 dark:text-pink-300',
        rose: 'border-transparent bg-rose-200 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300',
        // INSERT_YOUR_CODE
        // 50+ vividly colorful badge variants with distinct tints/shades, not just grayscale!
        gray: 'border-transparent bg-gray-200 text-gray-800 dark:bg-gray-900/50 dark:text-gray-300',
        coolgray:
          'bg-cool-gray-200 text-cool-gray-800 dark:bg-cool-gray-900/50 dark:text-cool-gray-300 border-transparent',
        stone:
          'border-transparent bg-stone-200 text-stone-800 dark:bg-stone-900/50 dark:text-stone-300',
        slate:
          'border-transparent bg-slate-200 text-slate-800 dark:bg-slate-900/50 dark:text-slate-300',
        zinc: 'border-transparent bg-zinc-200 text-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300',
        neutral:
          'border-transparent bg-neutral-200 text-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-300',
        warmgray:
          'bg-warm-gray-200 text-warm-gray-800 dark:bg-warm-gray-900/50 dark:text-warm-gray-300 border-transparent',

        ash: 'border-transparent bg-[#bdbdbd] text-[#263238] dark:bg-[#263238]/50 dark:text-[#bdbdbd]',
        charcoal:
          'border-transparent bg-[#374151] text-[#f3f4f6] dark:bg-[#1f2937]/50 dark:text-[#d1d5db]',
        ivory:
          'border-transparent bg-[#fffff0] text-[#4b5563] dark:bg-[#e5e7eb]/50 dark:text-[#18181b]',

        mint: 'border-transparent bg-[#dafbe1] text-[#097969] dark:bg-[#097969]/30 dark:text-[#dafbe1]',
        turquoise:
          'border-transparent bg-[#afecef] text-[#007c91] dark:bg-[#017286]/30 dark:text-[#afecef]',
        olive:
          'border-transparent bg-[#d9ead3] text-[#5f7a36] dark:bg-[#5f7a36]/40 dark:text-[#d9ead3]',

        magenta:
          'border-transparent bg-[#ff80bf] text-[#ad175a] dark:bg-[#8d1150]/30 dark:text-[#ffbae2]',
        scarlet:
          'border-transparent bg-[#ff2400] text-white dark:bg-[#7f0d00]/30 dark:text-[#ffe1dd]',
        crimson:
          'border-transparent bg-[#dc143c] text-white dark:bg-[#75122a]/40 dark:text-[#ffb3cb]',
        ruby: 'border-transparent bg-[#e0115f] text-white dark:bg-[#76002b]/30 dark:text-[#fac5dd]',
        maroon:
          'border-transparent bg-[#800000] text-white dark:bg-[#2d0000]/60 dark:text-[#fdcccc]',

        coral:
          'border-transparent bg-[#ff7f50] text-[#a53a2a] dark:bg-[#852912]/40 dark:text-[#ffe2d5]',
        peach:
          'border-transparent bg-[#ffcbad] text-[#c97b63] dark:bg-[#a26a4d]/40 dark:text-[#fff4ee]',
        salmon:
          'border-transparent bg-[#fa8072] text-[#ac3934] dark:bg-[#93302d]/40 dark:text-[#ffdedb]',
        apricot:
          'border-transparent bg-[#fbceb1] text-[#bc7256] dark:bg-[#874b33]/40 dark:text-[#fff3ea]',
        tangerine:
          'border-transparent bg-[#ffcc00] text-[#b88a00] dark:bg-[#704800]/40 dark:text-[#fff7cc]',

        gold: 'border-transparent bg-[#ffd700] text-[#ad9100] dark:bg-[#746200]/50 dark:text-[#fff6ae]',
        bronze:
          'border-transparent bg-[#cd7f32] text-white dark:bg-[#79542b]/40 dark:text-[#ffe6c4]',
        copper:
          'border-transparent bg-[#b87333] text-white dark:bg-[#7c4521]/40 dark:text-[#ffd9b3]',
        honey:
          'border-transparent bg-[#ffc30b] text-[#9f7700] dark:bg-[#584200]/40 dark:text-[#ffe794]',
        amberVivid:
          'border-transparent bg-[#ffbf00] text-[#a37400] dark:bg-[#694800]/40 dark:text-[#fff3cc]',

        chartreuse:
          'border-transparent bg-[#d4ff00] text-[#6a8900] dark:bg-[#3b5700]/40 dark:text-[#f9ffe0]',
        limeVivid:
          'border-transparent bg-[#d0ff14] text-[#6c8a02] dark:bg-[#3c5704]/40 dark:text-[#f9ffcf]',
        spring:
          'border-transparent bg-[#00ff7f] text-[#017a42] dark:bg-[#025b31]/40 dark:text-[#c6ffe7]',
        jade: 'border-transparent bg-[#00a86b] text-white dark:bg-[#03432c]/40 dark:text-[#baffdf]',
        moss: 'border-transparent bg-[#8a9a5b] text-white dark:bg-[#3f430e]/70 dark:text-[#dee9ad]',

        aquamarine:
          'border-transparent bg-[#7fffd4] text-[#157a62] dark:bg-[#1d6150]/40 dark:text-[#e0fcf5]',
        celeste:
          'border-transparent bg-[#b2ffff] text-[#217983] dark:bg-[#1a4c45]/40 dark:text-[#e5ffff]',
        cyanBright:
          'border-transparent bg-[#00fff7] text-[#027b8b] dark:bg-[#024b52]/40 dark:text-[#cffffa]',
        cerulean:
          'border-transparent bg-[#007ba7] text-white dark:bg-[#003549]/40 dark:text-[#bde7f7]',
        azure:
          'border-transparent bg-[#007fff] text-white dark:bg-[#003f66]/40 dark:text-[#c4e6ff]',

        skyBright:
          'border-transparent bg-[#87ceeb] text-[#084969] dark:bg-[#0d3753]/40 dark:text-[#eafffd]',
        periwinkle:
          'border-transparent bg-[#ccccff] text-[#343477] dark:bg-[#2b2b54]/40 dark:text-[#f3f3ff]',
        indigoBright:
          'border-transparent bg-[#6f00ff] text-white dark:bg-[#3a0066]/40 dark:text-[#e6ccff]',
        violetBright:
          'border-transparent bg-[#8f00ff] text-white dark:bg-[#42087c]/40 dark:text-[#e0c2fb]',
        amethyst:
          'border-transparent bg-[#9966cc] text-white dark:bg-[#3b2163]/50 dark:text-[#e3d3f5]',

        lavender:
          'border-transparent bg-[#e6e6fa] text-[#635d8c] dark:bg-[#35315b]/40 dark:text-[#faf8ff]',
        plum: 'border-transparent bg-[#dda0dd] text-[#683870] dark:bg-[#3a194b]/40 dark:text-[#f8e2ff]',
        lilac:
          'border-transparent bg-[#c8a2c8] text-[#5c375c] dark:bg-[#3b204b]/50 dark:text-[#f4e2ff]',
        orchid:
          'border-transparent bg-[#da70d6] text-[#7a2f7a] dark:bg-[#522352]/40 dark:text-[#fff0fa]',
        fuchsiaBright:
          'border-transparent bg-[#ff33ff] text-[#a600a6] dark:bg-[#6b006b]/40 dark:text-[#ffd6ff]',

        roseBright:
          'border-transparent bg-[#ff66cc] text-[#ad2677] dark:bg-[#7f2358]/40 dark:text-[#fff2fd]',
        hotpink:
          'border-transparent bg-[#ff69b4] text-[#a01568] dark:bg-[#720c45]/40 dark:text-[#ffcfea]',
        flamingo:
          'border-transparent bg-[#fc8eac] text-[#7a2443] dark:bg-[#4b1730]/40 dark:text-[#ffe7f2]',
        cherry:
          'border-transparent bg-[#de3163] text-white dark:bg-[#7a1433]/50 dark:text-[#ffd4e6]',
        sangria:
          'border-transparent bg-[#92000a] text-white dark:bg-[#390005]/60 dark:text-[#ffcad7]',

        sand: 'border-transparent bg-[#f4e2d8] text-[#9f7162] dark:bg-[#4b332c]/40 dark:text-[#fff6ee]',
        rust: 'border-transparent bg-[#b7410e] text-white dark:bg-[#471805]/60 dark:text-[#ffe1d2]',
        ochre:
          'border-transparent bg-[#cc7722] text-white dark:bg-[#573310]/60 dark:text-[#ffd8ab]',
        lemon:
          'border-transparent bg-[#fff700] text-[#bbbb00] dark:bg-[#666400]/50 dark:text-[#fffec7]',
        banana:
          'border-transparent bg-[#ffe135] text-[#b9a706] dark:bg-[#85801a]/40 dark:text-[#fff9c9]',
        apricotBright:
          'border-transparent bg-[#fbceb1] text-[#bc7256] dark:bg-[#874b33]/40 dark:text-[#fff3ea]',
        melon:
          'border-transparent bg-[#f7b483] text-[#966226] dark:bg-[#633f13]/40 dark:text-[#ffeada]',

        algae:
          'border-transparent bg-[#80ff72] text-[#146c28] dark:bg-[#184820]/40 dark:text-[#dfffe8]',
        aloe: 'border-transparent bg-[#dafbe1] text-[#19764e] dark:bg-[#11452c]/40 dark:text-[#daffe9]',
        forest:
          'border-transparent bg-[#228b22] text-white dark:bg-[#103613]/60 dark:text-[#d7ffd7]',
        seafoam:
          'border-transparent bg-[#94f9e5] text-[#266561] dark:bg-[#174644]/40 dark:text-[#e8fffa]',
        tealBright:
          'border-transparent bg-[#00f5e0] text-[#089187] dark:bg-[#076b61]/40 dark:text-[#d7fffb]',

        ultramarine:
          'border-transparent bg-[#120a8f] text-white dark:bg-[#09075a]/60 dark:text-[#b0bfff]',
        bluejeans:
          'border-transparent bg-[#5da9e9] text-[#17416c] dark:bg-[#152957]/40 dark:text-[#e3f1ff]',
        eggplant:
          'border-transparent bg-[#614051] text-white dark:bg-[#402039]/60 dark:text-[#f5d2e7]',
        grape:
          'border-transparent bg-[#6f2da8] text-white dark:bg-[#371159]/60 dark:text-[#ecd7ff]',
        night:
          'border-transparent bg-[#121212cc] text-[#e0e0e0] dark:bg-[#060606]/80 dark:text-[#fafafa]',

        sapphire:
          'border-transparent bg-[#0f52ba] text-white dark:bg-[#071634]/80 dark:text-[#c7d7ff]',
        blush:
          'border-transparent bg-[#de5d83] text-white dark:bg-[#65162d]/70 dark:text-[#ffdde8]',
        peppermint:
          'border-transparent bg-[#c1f7c5] text-[#2b704e] dark:bg-[#125e27]/50 dark:text-[#e7fff4]',
        caramel:
          'border-transparent bg-[#af6e4d] text-white dark:bg-[#452f22]/60 dark:text-[#ffe7d2]',
        pistachio:
          'border-transparent bg-[#93c572] text-[#355125] dark:bg-[#193312]/60 dark:text-[#ecffd8]',
        blueberry:
          'border-transparent bg-[#4f86f7] text-white dark:bg-[#142349]/60 dark:text-[#dbeaff]',
        storm:
          'border-transparent bg-[#71797e] text-white dark:bg-[#31363a]/60 dark:text-[#e7ebed]',
        licorice:
          'border-transparent bg-[#1a1110] text-white dark:bg-[#080707]/80 dark:text-[#eae7e7]',
        latte:
          'border-transparent bg-[#ffe5b4] text-[#795f29] dark:bg-[#4e3b19]/40 dark:text-[#fff7e1]',
        blushPink:
          'border-transparent bg-[#fe828c] text-[#832f38] dark:bg-[#6a2231]/50 dark:text-[#ffdde3]',
        mango:
          'border-transparent bg-[#ffc324] text-[#94710b] dark:bg-[#6d5100]/50 dark:text-[#fff3d7]',
        pine: 'border-transparent bg-[#01796f] text-white dark:bg-[#013732]/70 dark:text-[#cffffff]',
        fern: 'border-transparent bg-[#63a950] text-white dark:bg-[#21451d]/80 dark:text-[#dafed6]',
        marsh:
          'border-transparent bg-[#8db600] text-white dark:bg-[#2e3800]/70 dark:text-[#f3ffd7]',
        mossGreen:
          'border-transparent bg-[#addfad] text-[#416041] dark:bg-[#1f3320]/60 dark:text-[#e7ffe7]',
        spruce:
          'border-transparent bg-[#0a5f38] text-white dark:bg-[#002212]/60 dark:text-[#aaffdf]',
        twilight:
          'border-transparent bg-[#5d3fd3] text-white dark:bg-[#25176c]/70 dark:text-[#e7deff]',
        bluebell:
          'border-transparent bg-[#a2a2d0] text-[#474769] dark:bg-[#2a2a47]/50 dark:text-[#f1f1ff]',
        poppy:
          'border-transparent bg-[#e35335] text-white dark:bg-[#6d2014]/70 dark:text-[#ffe0dd]',
        vanilla:
          'border-transparent bg-[#f3e5ab] text-[#85714d] dark:bg-[#4e4329]/40 dark:text-[#fffbe7]',
        silver:
          'border-transparent bg-[#c0c0c0] text-[#484848] dark:bg-[#727272]/60 dark:text-[#f2f2f2]',
        graphite:
          'border-transparent bg-[#53565a] text-white dark:bg-[#242426]/80 dark:text-[#dadbdd]',
        space:
          'border-transparent bg-[#2b2d42] text-white dark:bg-[#10111a]/70 dark:text-[#a3aacd]',
        rain: 'border-transparent bg-[#b3cee5] text-[#3a546d] dark:bg-[#182c3f]/50 dark:text-[#e9f4fd]',
        icy: 'border-transparent bg-[#e0ffff] text-[#238899] dark:bg-[#174047]/40 dark:text-[#f6feff]',
        denim:
          'border-transparent bg-[#1560bd] text-white dark:bg-[#082244]/60 dark:text-[#c9dfff]',
        lagoon:
          'border-transparent bg-[#4eccc4] text-[#205155] dark:bg-[#183536]/50 dark:text-[#dbfaf7]',
        navyBright:
          'border-transparent bg-[#2243b6] text-white dark:bg-[#0c1935]/70 dark:text-[#c7d1ff]',
        blushRose:
          'border-transparent bg-[#eea9b8] text-[#914357] dark:bg-[#673040]/50 dark:text-[#fff2f6]',
        honeydew:
          'border-transparent bg-[#f0fff0] text-[#448860] dark:bg-[#163c2a]/40 dark:text-[#f2fff2]',
        apple:
          'border-transparent bg-[#66b447] text-white dark:bg-[#214912]/70 dark:text-[#d9ffd7]',
        cherryBlossom:
          'border-transparent bg-[#ffb7c5] text-[#914657] dark:bg-[#6a2939]/50 dark:text-[#fff3fa]',
        cocoa:
          'border-transparent bg-[#d2691e] text-white dark:bg-[#552d07]/70 dark:text-[#ffe4ce]',
        ocean:
          'border-transparent bg-[#3bb9ff] text-[#034265] dark:bg-[#001f33]/60 dark:text-[#e0f7ff]',
        blushPeach:
          'border-transparent bg-[#ffdab9] text-[#be7956] dark:bg-[#69412b]/50 dark:text-[#fff5e8]',
        latteFoam:
          'border-transparent bg-[#fff9e3] text-[#a89e82] dark:bg-[#786e53]/50 dark:text-[#fffef7]',
        marble:
          'border-transparent bg-[#dadada] text-[#484848] dark:bg-[#989898]/50 dark:text-[#fff]',
        pearl:
          'border-transparent bg-[#f0eada] text-[#857d70] dark:bg-[#68635a]/30 dark:text-[#fffef6]',
        rosewood:
          'border-transparent bg-[#65000b] text-white dark:bg-[#2c0008]/80 dark:text-[#ffe0ea]',
        obsidian:
          'border-transparent bg-[#28282b] text-white dark:bg-[#121215]/80 dark:text-[#ededf7]',
        petrol:
          'border-transparent bg-[#005f6a] text-white dark:bg-[#012229]/80 dark:text-[#d6f3ff]',
        sepia:
          'border-transparent bg-[#704214] text-white dark:bg-[#251706]/80 dark:text-[#f9e7ce]',
        wheat:
          'border-transparent bg-[#f5deb3] text-[#94734e] dark:bg-[#675947]/40 dark:text-[#fffceb]',
        rainbow: 'border border-primary/10 bg-primary text-primary-foreground', // placeholder, actual variant selected randomly
        transparent:
          'bg-base-50 text-base-500 hover:text-base-500 border-transparent text-sm font-medium',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

const badgeTextVariants = cva('text-xs font-medium', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      secondary: 'text-secondary-foreground',
      destructive: 'text-white',
      outline: 'text-foreground',
      oliveGreen: 'text-foreground',
      rosePink: 'text-foreground',
      rainbow: 'text-muted-foreground',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

const allVariants = [
  'success',
  'update',
  'warning',
  'terminal',
  'reset',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'mint',
  'turquoise',
  'olive',
  'magenta',
  'crimson',
  'coral',
  'peach',
  'salmon',
  'apricot',
  'honey',
  'amberVivid',
  'chartreuse',
  'limeVivid',
  'spring',
  'jade',
  'moss',
  'aquamarine',
  'celeste',
  'cyanBright',
  'skyBright',
  'periwinkle',
  'indigoBright',
  'violetBright',
  'amethyst',
  'lavender',
  'plum',
  'lilac',
  'orchid',
  'roseBright',
  'hotpink',
  'flamingo',
  'sand',
  'apricotBright',
  'melon',
  'algae',
  'aloe',
  'seafoam',
  'tealBright',
  'eggplant',
  'grape',
  'night',
  'sapphire',
  'blush',
  'peppermint',
  'caramel',
  'pistachio',
  'blueberry',
  'storm',
  'licorice',
  'latte',
  'blushPink',
  'mango',
  'pine',
  'fern',
  'mossGreen',
  'spruce',
  'twilight',
  'bluebell',
  'vanilla',
  'silver',
  'graphite',
  'space',
  'rain',
  'icy',
  'blushRose',
  'honeydew',
  'apple',
  'cherryBlossom',
  'blushPeach',
  'latteFoam',
  'marble',
  'pearl',
  'obsidian',
  'wheat',
] as const;

type BadgeProps = React.ComponentProps<typeof View> & {
  asChild?: boolean;
  label?: string;
} & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, asChild, label, ...props }: BadgeProps) {
  const Component = asChild ? Slot.View : View;
  const actualVariant =
    variant === 'rainbow' && typeof label === 'string'
      ? allVariants[label.length % allVariants.length]
      : variant;
  const textVariant =
    variant === 'secondary' ||
    variant === 'destructive' ||
    variant === 'outline' ||
    variant === 'oliveGreen' ||
    variant === 'rosePink' ||
    variant === 'rainbow'
      ? variant
      : 'default';

  return (
    <TextClassContext.Provider value={badgeTextVariants({ variant: textVariant })}>
      <Component className={cn(badgeVariants({ variant: actualVariant }), className)} {...props} />
    </TextClassContext.Provider>
  );
}

export { Badge, badgeTextVariants, badgeVariants };
export type { BadgeProps };

import { Icons } from '@/components/home/icons';
import { OrbitingCircles } from '@/components/home/ui/orbiting-circle';

export function SecondBentoAnimation() {
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <div className="pointer-events-none absolute bottom-0 left-0 h-20 w-full bg-gradient-to-t from-background to-transparent z-20"></div>
      <div className="pointer-events-none absolute top-0 left-0 h-20 w-full bg-gradient-to-b from-background to-transparent z-20"></div>

      <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 flex items-center justify-center gap-2 size-16 bg-black p-2 rounded-full z-30 md:bottom-0 md:top-auto">
        <img 
          src="/kortix-symbol.svg" 
          alt="Kortix Symbol" 
          className="size-10 filter brightness-0 invert"
        />
      </div>
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
        <div className="relative flex h-full w-full items-center justify-center translate-y-0 md:translate-y-32">
          <OrbitingCircles
            index={0}
            iconSize={60}
            radius={100}
            reverse
            speed={1}
          >
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/slack/slack-original.svg" alt="Slack" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/0/01/Google_Docs_logo_%282014-2020%29.svg" alt="Google Docs" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/3/34/Microsoft_Office_Excel_%282019%E2%80%93present%29.svg" alt="Excel" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg" alt="Gmail" className="size-8" />
            </div>
          </OrbitingCircles>

          <OrbitingCircles index={1} iconSize={60} speed={0.5}>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/a/a5/Google_Calendar_icon_%282020%29.svg" alt="Google Calendar" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/4/45/Notion_app_logo.png" alt="Notion" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="WhatsApp" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo_TV_2015.svg" alt="Trello" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/0/05/Google_Sheets_icon_%282020%29.svg" alt="Google Sheets" className="size-8" />
            </div>
          </OrbitingCircles>

          <OrbitingCircles
            index={2}
            iconSize={60}
            radius={230}
            reverse
            speed={0.5}
          >
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/d/df/Microsoft_Office_Outlook_%282018%E2%80%93present%29.svg" alt="Outlook" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/f/f9/Salesforce.com_logo.svg" alt="Salesforce" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://cdn.worldvectorlogo.com/logos/asana-logo.svg" alt="Asana" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/c/c9/Microsoft_Office_Teams_%282018%E2%80%93present%29.svg" alt="Teams" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Mail_%28iOS%29.svg/1024px-Mail_%28iOS%29.svg.png" alt="Apple Mail" className="size-8" />
            </div>
            <div className="size-12 bg-white rounded-full flex items-center justify-center shadow-lg border border-gray-100">
              <img src="https://upload.wikimedia.org/wikipedia/commons/c/ca/LinkedIn_logo_initials.png" alt="LinkedIn" className="size-8" />
            </div>
          </OrbitingCircles>
          
          {/* Additional outer ring for more tools */}
          <OrbitingCircles
            index={3}
            iconSize={50}
            radius={320}
            speed={0.3}
          >
            <div className="size-10 bg-white rounded-full flex items-center justify-center shadow-md border border-gray-100 opacity-75">
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/Google_Chrome_icon_%28February_2022%29.svg/480px-Google_Chrome_icon_%28February_2022%29.svg.png" alt="Chrome" className="size-6" />
            </div>
            <div className="size-10 bg-white rounded-full flex items-center justify-center shadow-md border border-gray-100 opacity-75">
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/Twitter_bird_logo_2012.svg/512px-Twitter_bird_logo_2012.svg.png" alt="Twitter" className="size-6" />
            </div>
            <div className="size-10 bg-white rounded-full flex items-center justify-center shadow-md border border-gray-100 opacity-75">
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Instagram_icon.png/600px-Instagram_icon.png" alt="Instagram" className="size-6" />
            </div>
            <div className="size-10 bg-white rounded-full flex items-center justify-center shadow-md border border-gray-100 opacity-75">
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Facebook_Logo_%282019%29.png/600px-Facebook_Logo_%282019%29.png" alt="Facebook" className="size-6" />
            </div>
            <div className="size-10 bg-white rounded-full flex items-center justify-center shadow-md border border-gray-100 opacity-75">
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/Zoom_Icon.png/600px-Zoom_Icon.png" alt="Zoom" className="size-6" />
            </div>
            <div className="size-10 bg-white rounded-full flex items-center justify-center shadow-md border border-gray-100 opacity-75">
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Dropbox_Icon.svg/480px-Dropbox_Icon.svg.png" alt="Dropbox" className="size-6" />
            </div>
            <div className="size-10 bg-white rounded-full flex items-center justify-center shadow-md border border-gray-100 opacity-75">
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/c/c2/GitHub_Invertocat_Logo.svg/480px-GitHub_Invertocat_Logo.svg.png" alt="GitHub" className="size-6" />
            </div>
            <div className="size-10 bg-white rounded-full flex items-center justify-center shadow-md border border-gray-100 opacity-75">
              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/ChatGPT_logo.svg/480px-ChatGPT_logo.svg.png" alt="OpenAI" className="size-6" />
            </div>
          </OrbitingCircles>
        </div>
      </div>
    </div>
  );
}

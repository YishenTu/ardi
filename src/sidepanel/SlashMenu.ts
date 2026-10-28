import type { PiCommand } from "../chat";
import type { Composer } from "./Composer";
import { Dropup } from "./Dropup";

// A command in the menu. Ardi's own commands run when picked; pi's commands
// (skills) are inserted into the composer so the user can add a request.
type Command = { name: string; description: string; run?: () => void };

// The list that opens above the composer when the message starts with "/".
export class SlashMenu {
  private readonly menu: Dropup;
  private piCommands: Command[] = [];

  constructor(
    private readonly input: Composer,
    list: HTMLElement,
    private readonly builtins: Command[],
  ) {
    this.menu = new Dropup(list);
  }

  setCommands(commands: PiCommand[]) {
    this.piCommands = commands.map((c) => ({ name: c.name, description: c.description ?? "" }));
    this.update();
  }

  // Opens, filters or closes the menu from what's typed. Only a leading
  // "/word" with no space yet counts as a command.
  update() {
    const match = /^\/(\S*)$/.exec(this.input.value);
    if (!match) return this.menu.close();
    const query = match[1].toLowerCase();
    const filter = (list: Command[]) => list.filter((c) => c.name.toLowerCase().includes(query));
    const builtins = filter(this.builtins);
    const matches = [...builtins, ...filter(this.piCommands)];
    this.menu.show(
      matches.map((c, i) => ({ name: `/${c.name}`, description: c.description, divider: i === builtins.length && i > 0 })),
      (i) => this.pick(matches[i]),
    );
  }

  // Handles a key in the composer; returns true when the menu used it.
  keydown(e: KeyboardEvent): boolean {
    return this.menu.keydown(e);
  }

  private pick(command: Command) {
    if (command.run) {
      this.input.value = "";
      command.run();
    } else {
      this.input.value = `/${command.name} `;
    }
  }
}

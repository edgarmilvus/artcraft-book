// Binding manifest — canonical, versioned alongside the deck.
//
// The map is the documented equivalent of a named binding: it says which
// frame of the deck carries which figure of which workbook, and which
// DeckCraft command refreshes that frame.  The frame ids are the shape ids
// the engine reports, so the map is always a description of a deck that
// really exists.
interface BindingEntry {
  deck_frame_id: number;         // the shape id from inspect_slide
  slide_index: number;           // 0-based
  source_kind: "cell" | "name" | "range";
                                  // a cell ("Consolidated!B7"), a defined
                                  // name ("Helios.Revenue.Q3") or a range
                                  // ("Scenarios!A1:C4") for a chart
  source_book: string;           // "helios-consolidated" | "close-reconciliation"
  source_ref: string;            // "Consolidated!B7" | "Helios.Revenue.Q3"
  format: string;                // "0,000" | "$0.0M" | "0.00%" | "$0K"
  prefix?: string;               // the label the figure is written behind
  refresh_command: string;       // "text.set" or "chart.data"
  slot?: string;                 // the name the frame carries in the deck
  label?: string;                // what the figure is called
  value?: number | string | null;// the figure as it was last bound
  display?: string | null;       // the figure as it reads on the slide
}

interface BindingMap {
  version: string;
  deck_path: string;
  entries: BindingEntry[];
}

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

pub fn encode(key: KeyEvent, application_cursor: bool) -> Vec<u8> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let modifier = 1 + u8::from(shift) + 2 * u8::from(alt) + 4 * u8::from(ctrl);
    let arrow = |suffix: char| {
        if modifier > 1 {
            format!("\x1b[1;{modifier}{suffix}")
        } else {
            format!("\x1b{}{suffix}", if application_cursor { 'O' } else { '[' })
        }
    };
    let tilde = |number: u8| {
        if modifier > 1 {
            format!("\x1b[{number};{modifier}~")
        } else {
            format!("\x1b[{number}~")
        }
    };
    let value = match key.code {
        KeyCode::Char(c) if ctrl && c.is_ascii() => {
            let b = match c {
                ' ' | '@' => 0,
                '?' => 127,
                _ => (c.to_ascii_uppercase() as u8) & 0x1f,
            };
            let mut bytes = vec![b];
            if alt {
                bytes.insert(0, 27);
            }
            return bytes;
        }
        KeyCode::Char(c) => {
            let mut s = c.to_string();
            if alt {
                s.insert(0, '\x1b');
            }
            s
        }
        KeyCode::Enter => if alt { "\x1b\r" } else { "\r" }.into(),
        KeyCode::Backspace => "\x7f".into(),
        KeyCode::Tab => "\t".into(),
        KeyCode::BackTab => "\x1b[Z".into(),
        KeyCode::Esc => "\x1b".into(),
        KeyCode::Up => arrow('A'),
        KeyCode::Down => arrow('B'),
        KeyCode::Right => arrow('C'),
        KeyCode::Left => arrow('D'),
        KeyCode::Home => arrow('H'),
        KeyCode::End => arrow('F'),
        KeyCode::Insert => tilde(2),
        KeyCode::Delete => tilde(3),
        KeyCode::PageUp => tilde(5),
        KeyCode::PageDown => tilde(6),
        KeyCode::F(n) if (1..=4).contains(&n) => {
            if modifier == 1 {
                format!("\x1bO{}", char::from(b'P' + n - 1))
            } else {
                format!("\x1b[1;{modifier}{}", char::from(b'P' + n - 1))
            }
        }
        KeyCode::F(n) if (5..=12).contains(&n) => {
            tilde([15, 17, 18, 19, 20, 21, 23, 24][(n - 5) as usize])
        }
        _ => String::new(),
    };
    value.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_control_sequences_preserve_modifiers_and_unicode() {
        assert_eq!(
            encode(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                false
            ),
            [3]
        );
        assert_eq!(
            encode(KeyEvent::new(KeyCode::Up, KeyModifiers::CONTROL), false),
            b"\x1b[1;5A"
        );
        assert_eq!(
            encode(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE), true),
            b"\x1bOA"
        );
        assert_eq!(
            encode(
                KeyEvent::new(KeyCode::Char('日'), KeyModifiers::NONE),
                false
            ),
            "日".as_bytes()
        );
    }
}

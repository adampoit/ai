#![deny(clippy::clone_on_copy)]

pub fn unnecessary_clone(value: i32) -> i32 {
    value.clone()
}

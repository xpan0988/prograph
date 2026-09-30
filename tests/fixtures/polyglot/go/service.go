package service
import "fmt"
type Base struct {}
type Item[T any] struct { Base; Value T }
type Loader interface { Load() string }
func Helper() string { return fmt.Sprint("ok") }
func (b Base) Load() string { return Helper() }
